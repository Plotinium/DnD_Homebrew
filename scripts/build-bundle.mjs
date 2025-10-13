// scripts/build-bundle.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = process.cwd();

 // adatta alle tue cartelle
const ROOTS = [
  "races",
  "feats",
  "classes",
  "subclasses",
  "items",
  "spells"
];

const OUT_DIR = path.join(CWD, "dist");
const OUT_FILE = path.join(OUT_DIR, "homebrew-bundle.json");

const bundle = {};
const meta = { sources: [] };

const addSources = (srcArr) => {
  if (!Array.isArray(srcArr)) return;
  for (const s of srcArr) {
    if (!s || !s.json) continue;
    if (!meta.sources.some((x) => x.json === s.json)) meta.sources.push(s);
  }
};

for (const dir of ROOTS) {
  const p = path.join(CWD, dir);
  if (!fs.existsSync(p)) continue;

  for (const f of fs.readdirSync(p).filter((x) => x.endsWith(".json"))) {
    const full = path.join(p, f);
    const j = JSON.parse(fs.readFileSync(full, "utf8"));

    if (j._meta?.sources) addSources(j._meta.sources);
    if (j._meta?.edition && !meta.edition) meta.edition = j._meta.edition;

    for (const k of Object.keys(j)) {
      if (k === "_meta") continue;
      if (Array.isArray(j[k])) {
        bundle[k] = (bundle[k] || []).concat(j[k]);
      }
    }
  }
}

// fallback se non trovato in input
meta.edition = meta.edition || "2024";
meta.dateAdded = Math.floor(Date.now() / 1000);

const out = { _meta: meta, ...bundle };
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

console.log(`Bundle scritto in: ${OUT_FILE}`);