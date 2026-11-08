/**
 * Document library: reads company documents, splits them into passages, and searches them (BM25).
 * Works for Thai and English (Intl.Segmenter splits Thai text into words).
 *
 * docs/<folder>/<file>   — the top-level folder is the access group (e.g. public, hr, finance)
 * Supported: .pdf .docx .md .txt .html .csv
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EXTS = new Set([".pdf", ".docx", ".md", ".markdown", ".txt", ".html", ".htm", ".csv"]);
const CHUNK_CHARS = 2400;
const segmenter = new Intl.Segmenter("th", { granularity: "word" });

export function tokenize(text) {
  const out = [];
  for (const s of segmenter.segment(String(text).toLowerCase())) if (s.isWordLike && s.segment.trim()) out.push(s.segment);
  return out;
}

/* ---------------------------------------------------------------- reading files */
async function readPages(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => ({ page: i + 1, text: t }));
  }
  if (ext === ".docx") {
    const mammoth = (await import("mammoth")).default;
    const { value } = await mammoth.extractRawText({ path: file });
    return [{ page: null, text: value }];
  }
  let text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  if (ext === ".html" || ext === ".htm") {
    text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|div|h\d|li|tr|br)>/gi, "\n").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return [{ page: null, text }];
}

// Split a page into passages of ~CHUNK_CHARS at paragraph boundaries, remembering the latest heading.
function chunkPage(text, page) {
  const paras = text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = [], size = 0, heading = null, chunkHeading = null;
  const flush = () => { if (cur.length) chunks.push({ page, heading: chunkHeading, paragraphs: cur }); cur = []; size = 0; };
  for (let p of paras) {
    const h = /^#{1,6}\s+(.+)$/m.exec(p);
    if (h && p.split("\n").length === 1) heading = h[1].trim();
    while (p.length > CHUNK_CHARS) {                       // very long paragraph: hard split
      if (size) flush();
      chunkHeading = heading;
      cur.push(p.slice(0, CHUNK_CHARS)); flush();
      p = p.slice(CHUNK_CHARS);
    }
    if (size + p.length > CHUNK_CHARS && size) flush();
    if (!cur.length) chunkHeading = heading;
    cur.push(p); size += p.length;
  }
  flush();
  return chunks;
}

/* ---------------------------------------------------------------- the library */
export class Library {
  constructor(docsDir, cacheFile) {
    this.docsDir = docsDir;
    this.cacheFile = cacheFile;
    this.docs = [];     // { path, folder, title, updated, pages, chunks: [...] }
    this.chunks = [];   // flat list with doc reference
  }

  /** Read new/changed files (cached by content hash) and rebuild the search index. Returns a summary. */
  async refresh(log = () => {}) {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")); } catch { /* first run */ }
    const next = {}, docs = [], problems = [];
    let added = 0;
    for (const file of this.#files(this.docsDir)) {
      const rel = path.relative(this.docsDir, file).replaceAll("\\", "/");
      const buf = fs.readFileSync(file);
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      let entry = cache[rel]?.hash === hash ? cache[rel] : null;
      if (!entry) {
        try {
          const pages = await readPages(file);
          const chunks = pages.flatMap((p) => chunkPage(p.text, p.page));
          entry = { hash, pages: pages.length, chunks };
          added++;
          log(`indexed ${rel} (${chunks.length} passages)`);
        } catch (e) {
          problems.push(`${rel}: ${e.message}`);
          continue;
        }
      }
      next[rel] = entry;
      const folder = rel.includes("/") ? rel.split("/")[0] : "public";
      docs.push({
        path: rel, folder, title: path.basename(rel).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
        updated: fs.statSync(file).mtime.toISOString().slice(0, 10), pages: entry.pages, chunks: entry.chunks,
      });
    }
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify(next));
    this.docs = docs;
    this.#buildIndex();
    return { documents: docs.length, passages: this.chunks.length, newOrChanged: added, removed: Object.keys(cache).filter((k) => !next[k]).length, problems };
  }

  *#files(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) yield* this.#files(full);
      else if (EXTS.has(path.extname(e.name).toLowerCase())) yield full;
    }
  }

  #buildIndex() {
    this.chunks = [];
    this.df = new Map();
    for (const doc of this.docs) {
      doc.chunks.forEach((c, i) => {
        const text = c.paragraphs.join("\n\n");
        const tokens = tokenize(`${doc.title} ${c.heading || ""} ${text}`);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
        this.chunks.push({ doc, index: i, page: c.page, heading: c.heading, paragraphs: c.paragraphs, tf, len: tokens.length });
      });
    }
    this.avgLen = this.chunks.reduce((s, c) => s + c.len, 0) / (this.chunks.length || 1);
  }

  /** BM25 search over the folders the user may see. */
  search(query, allowed, topK = 6) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const N = this.chunks.length, k1 = 1.4, b = 0.75;
    const scored = [];
    for (const c of this.chunks) {
      if (!canSee(allowed, c.doc.folder)) continue;
      let score = 0;
      for (const t of terms) {
        const f = c.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) || 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / this.avgLen));
      }
      if (score > 0) scored.push({ c, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topK).map((s) => s.c);
  }

  documentsFor(allowed) { return this.docs.filter((d) => canSee(allowed, d.folder)); }

  passagesOf(docPath, allowed, fromPage, toPage) {
    const doc = this.docs.find((d) => d.path === docPath);
    if (!doc || !canSee(allowed, doc.folder)) return null;
    return this.chunks.filter((c) => c.doc === doc && (fromPage == null || c.page == null || (c.page >= fromPage && c.page <= (toPage ?? fromPage))));
  }
}

export function canSee(allowed, folder) {
  return allowed.includes("*") || allowed.includes(folder);
}

/** A passage as a citable search_result block (each paragraph is a citable unit). */
export function toSearchResult(c) {
  const source = `docs/${c.doc.path}${c.page ? `#page=${c.page}` : ""}`;
  const title = [c.doc.title, c.page ? `p.${c.page}` : null, c.heading].filter(Boolean).join(" · ") + ` (updated ${c.doc.updated})`;
  return {
    type: "search_result",
    source,
    title,
    content: c.paragraphs.slice(0, 30).map((p) => ({ type: "text", text: p })),
    citations: { enabled: true },
  };
}
