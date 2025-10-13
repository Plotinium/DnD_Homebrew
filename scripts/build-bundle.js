// scripts/build-bundle.js
// Esegui con: `node scripts/build-bundle.js`
// Funzioni: valida ogni file con test-json-brew, unisce gli array top-level,
// costruisce _meta (sources, edition, dateAdded, dateLastModified).

const fs = require("fs");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

// Adatta questi nomi di cartelle alla tua struttura
const ROOTS = ["races", "feats", "classes", "subclasses", "items", "spells"];

const OUT_DIR = "dist";
const OUT_FILE = path.join(OUT_DIR, "homebrew-bundle.json");

const bundle = {};
const meta = { sources: [] };

// Raccogliamo valori per calcolare dateAdded (min) e dateLastModified (max)
let minDateAdded = Number.POSITIVE_INFINITY;
let maxDateLastMod = 0;
let detectedEdition = null;

const addSources = (srcArr) => {
  if (!Array.isArray(srcArr)) return;
  for (const s of srcArr) {
    if (!s || !s.json) continue;
    if (!meta.sources.some((x) => x.json === s.json)) meta.sources.push(s);
  }
};

const getGitLastModified = (fileAbs) => {
  try {
    // timestamp UNIX (sec) dell’ultimo commit che ha toccato il file
    const ts = execSync(`git log -1 --format=%ct -- "${fileAbs}"`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const n = Number(ts);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};

const getFsMtime = (fileAbs) => {
  try {
    const st = fs.statSync(fileAbs);
    return Math.floor(st.mtimeMs / 1000);
  } catch {
    return null;
  }
};

const validateWith5eTools = (fileAbs) => {
  const bin = path.join(process.cwd(), "node_modules", ".bin", "test-json-brew");
  if (!fs.existsSync(bin)) {
    throw new Error(
      `Validator non trovato: ${bin}. Assicurati di avere "5etools-utils" nelle devDependencies ed esegui "npm i".`
    );
  }
  const res = spawnSync(bin, [fileAbs], { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`Validazione fallita per: ${fileAbs}`);
  }
};

for (const dir of ROOTS) {
  const p = path.join(process.cwd(), dir);
  if (!fs.existsSync(p)) continue;

  const files = fs.readdirSync(p).filter((x) => x.endsWith(".json"));
  for (const f of files) {
    const fileAbs = path.join(p, f);

    // 1) Valida il singolo file con 5etools-utils
    validateWith5eTools(fileAbs);

    // 2) Carica e unisci
    const j = JSON.parse(fs.readFileSync(fileAbs, "utf8"));

    // 2.a) _meta: unisci sources, edition, dateAdded, dateLastModified per il bundle
    if (j._meta) {
      if (Array.isArray(j._meta.sources)) addSources(j._meta.sources);

      // Preferisci edition coerente; se trovi mix, scegli "2024" come default (modifica a piacere)
      if (j._meta.edition && !detectedEdition) detectedEdition = j._meta.edition;

      if (Number.isFinite(j._meta.dateAdded)) {
        minDateAdded = Math.min(minDateAdded, j._meta.dateAdded);
      }
      if (Number.isFinite(j._meta.dateLastModified)) {
        maxDateLastMod = Math.max(maxDateLastMod, j._meta.dateLastModified);
      }
    }

    // Git last modified come fallback/miglioramento per dateLastModified
    const gitTs = getGitLastModified(fileAbs) ?? getFsMtime(fileAbs);
    if (Number.isFinite(gitTs)) {
      maxDateLastMod = Math.max(maxDateLastMod, gitTs);
      if (!Number.isFinite(minDateAdded)) {
        // Se non hai mai visto dateAdded, usa come prima approssimazione gitTs
        minDateAdded = gitTs;
      }
    }

    // 2.b) Unisci gli array top-level (race, item, feat, ecc.)
    for (const k of Object.keys(j)) {
      if (k === "_meta") continue;
      if (Array.isArray(j[k])) {
        bundle[k] = (bundle[k] || []).concat(j[k]);
      }
    }
  }
}

// 3) Rifinisci il meta del bundle
meta.edition = detectedEdition || "2024"; // o "classic" se preferisci l’edizione 2014
meta.dateAdded = Number.isFinite(minDateAdded)
  ? minDateAdded
  : Math.floor(Date.now() / 1000);
meta.dateLastModified = Number.isFinite(maxDateLastMod)
  ? maxDateLastMod
  : Math.floor(Date.now() / 1000);

// 4) Scrivi il bundle finale
const out = { _meta: meta, ...bundle };
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

console.log(`✅ Bundle scritto in: ${OUT_FILE}`);
console.log(
  `   _meta: edition=${meta.edition}, dateAdded=${meta.dateAdded}, dateLastModified=${meta.dateLastModified}`
);
