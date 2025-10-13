// scripts/build-bundle.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");

// Whitelist delle chiavi top-level che 5eTools si aspetta come array
// Aggiungi qui man mano che espandi il repo.
const ALLOWED_KEYS = new Set([
  "race",
  "class",
  "subclass",
  "background",
  "feat",
  "item",
  "spell",
  "optionalfeature",
  "psionic",
  "monster",
  "vehicle",
  "variantrule",
  "table",
  "adventure",
  "book"
]);

/** Raccoglie tutti i file .json nelle cartelle di primo livello (race, class, ecc.) */
function getJsonFiles() {
  const entries = fs.readdirSync(ROOT, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory())
    .map(d => d.name)
    .filter(d =>
      !d.startsWith(".") &&
      !["_generated", "dist", "node_modules", "scripts", ".github"].includes(d)
    );

  const out = [];
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    for (const f of fs.readdirSync(abs)) {
      if (f.toLowerCase().endsWith(".json")) out.push(path.join(abs, f));
    }
  }
  return out;
}

function buildBundle() {
  const bundle = {};
  const files = getJsonFiles();

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    let j;
    try {
      j = JSON.parse(raw);
    } catch (e) {
      console.error(`JSON non valido: ${file}\n${e.message}`);
      process.exitCode = 1;
      continue;
    }

    for (const [k, v] of Object.entries(j)) {
      if (!Array.isArray(v)) continue;            // Prende solo array top-level
      if (!ALLOWED_KEYS.has(k)) continue;         // Filtro sulle chiavi note 5eTools
      bundle[k] = (bundle[k] || []).concat(v);
    }
  }

  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "dist", "homebrew-bundle.json"),
    JSON.stringify(bundle, null, 2),
    "utf8"
  );
  console.log(`Bundle creato: dist/homebrew-bundle.json`);
}

buildBundle();
