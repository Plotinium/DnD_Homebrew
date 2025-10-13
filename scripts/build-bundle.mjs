// scripts/build-bundle.mjs
// Esegui con: `node scripts/build-bundle.mjs`
//
// Funzioni:
// - Valida ogni file JSON con "test-json-brew" (5etools-utils)
// - Unisce gli array top-level (race, feat, item, ecc.)
// - Costruisce _meta del bundle con:
//     * sources (dedup)
//     * edition (dalla prima incontrata o dal bundle precedente, altrimenti default)
//     * dateAdded  (stabile: riuso dal vecchio bundle; altrimenti min per-file; altrimenti now)
//     * dateLastModified (massimo tra per-file/git/mtime; fallback now se 0)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Adatta questi nomi alle cartelle effettive del repo
const ROOTS = ["race", "feat", "class", "subclass", "item", "spell"];

const OUT_DIR = "dist";
const OUT_FILE = path.join(OUT_DIR, "homebrew-bundle.json");

// Usare un "now" coerente per tutta l'esecuzione
const NOW = Math.floor(Date.now() / 1000);

const bundle = {};
const meta = { sources: [] };

// Accumulatori per le date
let minDateAdded = Number.POSITIVE_INFINITY;
let maxDateLastMod = 0;
let detectedEdition = null;

// 1) Prova a leggere il vecchio bundle per rendere stabile `dateAdded`
function tryReadOldBundleMeta() {
  try {
    if (!fs.existsSync(OUT_FILE)) return null;
    const old = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
    if (!old?._meta) return null;
    return {
      dateAdded: Number.isFinite(old._meta.dateAdded) ? old._meta.dateAdded : null,
      edition: old._meta.edition || null,
    };
  } catch {
    return null;
  }
}

const oldBundleMeta = tryReadOldBundleMeta();

function resolveBin(name) {
  const bin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name
  );
  return bin;
}

function validateWith5eTools(fileAbs) {
  const bin = resolveBin("test-json-brew");
  if (!fs.existsSync(bin)) {
    throw new Error(
      `Validator non trovato: ${bin}. Installa "5etools-utils" come devDependency (npm i -D 5etools-utils).`
    );
  }
  const res = spawnSync(bin, [fileAbs], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`Validazione fallita: ${fileAbs}`);
}

function addSources(srcArr) {
  if (!Array.isArray(srcArr)) return;
  for (const s of srcArr) {
    if (!s?.json) continue;
    if (!meta.sources.some((x) => x.json === s.json)) meta.sources.push(s);
  }
}

function getGitLastModified(fileAbs) {
  try {
    const { stdout, status } = spawnSync(
      "git",
      ["log", "-1", "--format=%ct", "--", fileAbs],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    if (status === 0) {
      const n = Number(stdout.trim());
      return Number.isFinite(n) ? n : null;
    }
    return null;
  } catch {
    return null;
  }
}

function getFsMtime(fileAbs) {
  try {
    const st = fs.statSync(fileAbs);
    return Math.floor(st.mtimeMs / 1000);
  } catch {
    return null;
  }
}

// 2) Scorri le cartelle e processa i .json
for (const dir of ROOTS) {
  const p = path.join(process.cwd(), dir);
  if (!fs.existsSync(p)) continue;

  for (const f of fs.readdirSync(p).filter((x) => x.endsWith(".json"))) {
    const fileAbs = path.join(p, f);

    // 2.a) Valida il singolo file
    validateWith5eTools(fileAbs);

    // 2.b) Unisci contenuti
    const j = JSON.parse(fs.readFileSync(fileAbs, "utf8"));

    // _meta per-file: unisci sources/edition/date*
    if (j._meta) {
      if (Array.isArray(j._meta.sources)) addSources(j._meta.sources);
      if (j._meta.edition && !detectedEdition) detectedEdition = j._meta.edition;

      if (Number.isFinite(j._meta.dateAdded)) {
        minDateAdded = Math.min(minDateAdded, j._meta.dateAdded);
      }
      if (Number.isFinite(j._meta.dateLastModified)) {
        maxDateLastMod = Math.max(maxDateLastMod, j._meta.dateLastModified);
      }
    }

    // Ultima modifica del file: Git > mtime FS
    const ts = getGitLastModified(fileAbs) ?? getFsMtime(fileAbs);
    if (Number.isFinite(ts)) {
      maxDateLastMod = Math.max(maxDateLastMod, ts);
      // Se non abbiamo alcuna origine per dateAdded, usa almeno ts come candidato
      if (!Number.isFinite(minDateAdded)) minDateAdded = ts;
    }

    // Concatena gli array top-level noti
    for (const k of Object.keys(j)) {
      if (k === "_meta") continue;
      if (Array.isArray(j[k])) {
        bundle[k] = (bundle[k] || []).concat(j[k]);
      }
    }
  }
}

// 3) Finalizza i metadati del bundle

// edition: riusa dal vecchio bundle se non ne hai rilevata una nuova
meta.edition = detectedEdition || oldBundleMeta?.edition || "2024";

// dateAdded (stabile):
//   a) se esisteva nel vecchio bundle -> riusalo;
//   b) altrimenti, se abbiamo min per-file -> usalo;
//   c) altrimenti, inizializza ORA (prima e unica volta).
if (Number.isFinite(oldBundleMeta?.dateAdded)) {
  meta.dateAdded = oldBundleMeta.dateAdded;
} else if (Number.isFinite(minDateAdded)) {
  meta.dateAdded = minDateAdded;
} else {
  meta.dateAdded = NOW;
}

// dateLastModified:
//   usa il massimo calcolato; se non c'è (==0 o NaN), fallback a NOW (mai 0)
meta.dateLastModified =
  Number.isFinite(maxDateLastMod) && maxDateLastMod > 0 ? maxDateLastMod : NOW;

// 4) Scrivi l’output
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  OUT_FILE,
  JSON.stringify({ _meta: meta, ...bundle }, null, 2),
  "utf8"
);

console.log(`Bundle scritto in: ${OUT_FILE}`);
console.log(
  `   _meta: edition=${meta.edition}, dateAdded=${meta.dateAdded}, dateLastModified=${meta.dateLastModified}`
);
