import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import OpenAI from "openai";
import { ChromaClient } from "chromadb";

dotenv.config();

const openai = new OpenAI();
const chromaClient = new ChromaClient({ host: "localhost", port: 8000 });

await chromaClient.heartbeat();

const WEB_COLLECTION = `WEB_SCAPED_DATA_COLLECTION-1`;

function chunkText(text, chunkSize) {
  if (!text || chunkSize <= 0) return [];
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }
  return chunks;
}

function cleanHtmlContent(html) {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, .nav, .navigation, .menu").remove();
  return $.text().replace(/\s+/g, " ").trim();
}

async function scrapeWebPage(url = "") {
  try {
    console.log(`🔄 Scraping: ${url}`);
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const pageHead = $("head").html();
    const pageBody = $("body").html();

    const internalLinks = [];
    const externalLinks = [];

    $("a").each((_, el) => {
      const link = $(el).attr("href");
      if (link && link !== "/") {
        if (link.startsWith("http") || link.startsWith("https")) {
          externalLinks.push(link);
        } else if (link.startsWith("/")) {
          internalLinks.push(link);
        }
      }
    });

    return { head: pageHead, body: pageBody, internalLinks, externalLinks };
  } catch (error) {
    console.error(`❌ Error scraping ${url}:`, error.message);
    return { head: "", body: "", internalLinks: [], externalLinks: [] };
  }
}

async function generateVectorEmbeddings({ text }) {
  const embedding = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    encoding_format: "float",
  });
  return embedding.data[0].embedding;
}

async function insertIntoDB({ embedding, url, body = "", head }) {
  const collection = await chromaClient.getOrCreateCollection({
    name: WEB_COLLECTION,
  });

  // Create unique ID for each chunk
  const chunkId = `${url}-${Date.now()}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  await collection.add({
    ids: [chunkId],
    embeddings: [embedding],
    metadatas: [{ url, body, head }],
  });
}

const scrapedUrls = new Set(); // Prevent infinite loops

async function ingest(url = "", maxDepth = 2, currentDepth = 0) {
  // Prevent infinite loops and limit depth
  if (currentDepth >= maxDepth || scrapedUrls.has(url)) {
    return;
  }

  scrapedUrls.add(url);

  const { head, body, internalLinks } = await scrapeWebPage(url);

  if (!body) {
    console.log(`⚠️ No content found for ${url}`);
    return;
  }

  const cleanBody = cleanHtmlContent(body);
  const bodyChunks = chunkText(cleanBody, 1000);

  console.log(`📄 Processing ${bodyChunks.length} chunks for ${url}`);

  for (const chunk of bodyChunks) {
    if (chunk.trim().length > 50) {
      // Only process meaningful chunks
      const bodyEmbeddings = await generateVectorEmbeddings({ text: chunk });
      await insertIntoDB({ embedding: bodyEmbeddings, url, body: chunk, head });
    }
  }

  // Process internal links (limit to avoid infinite recursion)
  const limitedLinks = internalLinks.slice(0, 5); // Limit to first 5 links
  for (const link of limitedLinks) {
    let fullUrl;
    if (link.startsWith("/")) {
      const baseUrl = new URL(url).origin;
      fullUrl = `${baseUrl}${link}`;
    } else {
      fullUrl = `${url}/${link}`;
    }

    if (!scrapedUrls.has(fullUrl)) {
      await ingest(fullUrl, maxDepth, currentDepth + 1);
    }
  }

  console.log(`✅ Ingesting Success: ${url}`);
}

async function chat(question = "") {
  const collection = await chromaClient.getOrCreateCollection({
    name: WEB_COLLECTION,
  });

  const questionEmbeddings = await generateVectorEmbeddings({ text: question });

  const collectionResults = await collection.query({
    nResults: 5,
    queryEmbeddings: [questionEmbeddings],
  });

  if (
    !collectionResults.metadatas[0] ||
    collectionResults.metadatas[0].length === 0
  ) {
    console.log("❌ No data found in collection. Please run ingest first.");
    return;
  }

  const body = collectionResults["metadatas"][0]
    .map((e) => e.body)
    .filter((e) => e && e.trim() !== "");
  const url = collectionResults["metadatas"][0]
    .map((e) => e.url)
    .filter((e) => e && e.trim() !== "");

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are an AI support agent expert in providing support to users on behalf of a webpage.",
      },
      {
        role: "user",
        content: `
Query: ${question}

URLs: ${url.join(", ")}

Retrieved Context: ${body.join(" ")}
        `,
      },
    ],
  });

  console.log(`🤖: ${response.choices[0].message.content}`);
}

// MAIN EXECUTION
async function main(url = "", question = "") {
  try {
    console.log("🚀 Starting website ingestion...");

    // First, ingest the website
    await ingest(url);

    console.log(
      "\n🎯 Website ingestion complete! Now you can ask questions...\n"
    );

    // Then chat about it
    await chat(question);
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

// Run the main function
main("https://ssaswin.com", "Who is Aswin?");
