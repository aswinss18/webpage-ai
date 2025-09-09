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

  const words = text.split(/\s+/); // Split text into words (tokens)
  const chunks = [];

  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }

  return chunks;
}
async function scrapeWebPage(url = "") {
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);

  const pageHead = $("head").html();
  const pageBody = $("body").html();

  const internalLinks = [];
  const externalLinks = [];

  $("a").each((_, el) => {
    const link = $(el).attr("href");

    if (link == "/") return;
    if (link.startsWith("http") || link.startsWith("https")) {
      externalLinks.push(link);
    } else {
      internalLinks.push(link);
    }
  });

  return { head: pageHead, body: pageBody, internalLinks, externalLinks };
}

async function generateVectorEmbeddings({ text }) {
  const embedding = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    encoding_format: "float",
  });

  return embedding.data[0].embedding;
}

async function insertIntoDB({ embedding, url }) {
  const collection = await chromaClient.getOrCreateCollection({
    name: WEB_COLLECTION,
  });
}

async function ingest(url = "") {
  const { head, body, internalLinks } = await scrapeWebPage(url);

  const bodyChunks = chunkText(body, 2000);
  const headEmbedding = await generateVectorEmbeddings({ text: head });

  for (const chunk of bodyChunks) {
    const bodyEmbeddings = await generateVectorEmbeddings({ text: chunk });
  }
}

scrapeWebPage("https://ssaswin.com").then(console.log);
