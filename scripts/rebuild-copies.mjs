import { copyRebuildPage } from "../shared/contract.ts";

const origin = process.env.BONSAI_URL;
const key = process.env.BONSAI_KEY;
if (!origin || !key)
  throw new Error(
    "Set BONSAI_URL and BONSAI_KEY for the ordinary admitted method route.",
  );
const installation = process.env.BONSAI_INSTALLATION ?? "bonsai";
const url = new URL(
  `/apps/${encodeURIComponent(installation)}/methods/rebuildCopies`,
  origin,
);
let cursor = null;
let done = false;
let pages = 0;
while (!done) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cursor }),
  });
  if (!response.ok)
    throw new Error(`Read-copy rebuild refused (${String(response.status)})`);
  const page = copyRebuildPage.parse(await response.json());
  ({ cursor, done } = page);
  pages++;
  console.log(
    `Bonsai read copies: ${String(pages)} pages${done ? ", ready" : ", rebuilding"}`,
  );
}
