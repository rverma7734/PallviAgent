import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const number = process.argv[2] || "";
const outputPath = resolve(process.argv[3] || "telnyx-opt-in.html");
if (!/^\+1\d{10}$/.test(number)) {
  throw new Error("Usage: node scripts/create-telnyx-opt-in.mjs +1XXXXXXXXXX [output-path]");
}

const formatted = `+1 (${number.slice(2, 5)}) ${number.slice(5, 8)}-${number.slice(8)}`;
const source = await readFile(resolve("sms-opt-in.html"), "utf8");
const currentNumber = "+1 (516) 871-4383";
if (!source.includes(currentNumber)) {
  throw new Error(`Expected source number ${currentNumber} was not found in sms-opt-in.html`);
}

const output = source
  .replaceAll(currentNumber, formatted)
  .replace("PallviAgent SMS Emergency Intake Opt-In", "PallviAgent Telnyx SMS Emergency Intake Opt-In");
await writeFile(outputPath, output, "utf8");
console.log(`Created ${outputPath} for ${formatted}`);
