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

const RAW_ARGS = process.argv.slice(2);
function getArgKV(name, def) {
  const hit = RAW_ARGS.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split("=", 2)[1] : def;
}

// full | relaxed | off
const VALIDATE_MODE = getArgKV("validate", "full");

// Facoltativo: regex extra da ENV per ignorare messaggi specifici in modalità "relaxed"
// Esempio di uso in CI:
//   HOMEBREW_IGNORE_PATTERNS='/(homebrew|brew).*authori[sz]ed/i'
const IGNORE_PATTERNS_ENV = process.env.HOMEBREW_IGNORE_PATTERNS || "";
const EXTRA_IGNORE_REGEXES = IGNORE_PATTERNS_ENV
  .split(/\s*;;\s*|\s*\|\|\s*/).filter(Boolean)
  .map(s => {
    // permette sintassi tipo /regex/i oppure semplice testo
    const m = s.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) {
      return new RegExp(m[1], m[2]);
    }
    return new RegExp(s, "i");
  });

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

// ---------- Nuovo: helper per ignorare errori "conosciuti" in relaxed ----------
function isIgnorableInRelaxed(out) {
  // Normalizza per sicurezza (lowercase e senza spazi ridondanti)
  const s = String(out);

  // Caso A: enum su _meta.sources[*].json (come da tuo esempio)
  //   instancePath: "/_meta/sources/<n>/json"
  //   schemaPath: "sources-homebrew-legacy.json#/$defs/sourcesColon/enum"
  //   keyword: "enum"
  const isSourceEnumStrict =
    /"instancePath"\s*:\s*"\/_meta\/sources\/\d+\/json"/.test(s) &&
    /"schemaPath"\s*:\s*"[^"]*sources-homebrew[^"]*\/(sourcesColon|sourcesShort)\/enum"/.test(s) &&
    /"keyword"\s*:\s*"enum"/.test(s);

  // Caso B: fallback "testuale" (quando l'output non è JSON ma testo libero)
  //   - presenza di '/_meta/sources/.../json'
  //   - e di 'enum'
  //   - e di 'sourcesShort/enum' o 'sourcesColon/enum'
  const isSourceEnumTextual =
    /\/_meta\/sources\/.*\/json/.test(s) &&
    /\bsources(Short|Colon)\/enum\b/.test(s);

  // Caso C: pattern extra configurabili da ENV (opzionale)
  const isExtraIgnored = EXTRA_IGNORE_REGEXES.some((rx) => rx.test(s));

  return isSourceEnumStrict || isSourceEnumTextual || isExtraIgnored;
}

function validateWith5eTools(fileAbs) {
  if (VALIDATE_MODE === "off") {
    console.warn(`[validate/off] skip per-file: ${fileAbs}`);
    return;
  }

  const bin = resolveBin("test-json-brew");
  if (!fs.existsSync(bin)) {
    console.warn(`[validate/${VALIDATE_MODE}] validator non trovato: ${bin} — skip per-file`);
    return;
  }

  // Catturiamo stdout/stderr, non ereditiamo la console
  const res = spawnSync(bin, [fileAbs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (res.status === 0) return; // ok

  const out = `${res.stdout || ""}\n${res.stderr || ""}`;

  if (VALIDATE_MODE === "relaxed" && isIgnorableInRelaxed(out)) {
    // Non loggare i dettagli in console; tienili solo su file per eventuale debug
    try {
      fs.appendFileSync(
        "/tmp/bundle-validate.log",
        `\n[IGNORED][file=${fileAbs}]\n${out}\n`,
        "utf8"
      );
    } catch { }
    const rel = path.relative(process.cwd(), fileAbs);
    console.warn(
      `⚠️  [validate/relaxed] ignorato errore noto su file: ${rel} (dettagli soppressi; `
    );
    return;
  }

  // Non ignorabile: fallisci, ma prima mostra i dettagli
  console.error(out);
  throw new Error(`Validazione fallita per: ${fileAbs}`);
}

function validateFinalBundle(bundleAbs) {
  if (VALIDATE_MODE === "off") {
    console.warn(`[validate/off] skip final bundle: ${bundleAbs}`);
    return;
  }

  const bin = resolveBin("test-json-brew");
  if (!fs.existsSync(bin)) {
    console.warn(`[validate/${VALIDATE_MODE}] validator non trovato: ${bin} — skip final bundle`);
    return;
  }

  const res = spawnSync(bin, [bundleAbs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (res.status === 0) return;

  const out = `${res.stdout || ""}\n${res.stderr || ""}`;

  if (VALIDATE_MODE === "relaxed" && isIgnorableInRelaxed(out)) {
    // Non stampare i dettagli in console; salvali solo su file
    try {
      fs.appendFileSync(
        "/tmp/bundle-validate.log",
        `\n[IGNORED][bundle=${bundleAbs}]\n${out}\n`,
        "utf8"
      );
    } catch { }
    console.warn(
      `⚠️  [validate/relaxed] ignorato errore noto su BUNDLE: ${bundleAbs} `
    );
    return;
  }

  // Non ignorabile → fallisci
  console.error(out);
  throw new Error(`Validazione BUNDLE fallita: ${bundleAbs}`);
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

// dateAdded (stabile)
if (Number.isFinite(oldBundleMeta?.dateAdded)) {
  meta.dateAdded = oldBundleMeta.dateAdded;
} else if (Number.isFinite(minDateAdded)) {
  meta.dateAdded = minDateAdded;
} else {
  meta.dateAdded = NOW;
}

// dateLastModified
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

// 5) ---------- Nuovo: valida anche il BUNDLE finale ----------
try {
  validateFinalBundle(OUT_FILE);
  console.log(`[validate/${VALIDATE_MODE}] BUNDLE OK: ${OUT_FILE}`);
} catch (e) {
  // Mantieni un log su file per eventuale upload artifact dal workflow
  try {
    fs.writeFileSync("/tmp/bundle-validate.log", String(e?.stack || e), "utf8");
  } catch { }
  throw e;
}