import { drawFish, spawnFish, swim } from "./fish.js";
import { createPond, drawPond } from "./pond.js";

const canvas = document.querySelector<HTMLCanvasElement>("#pond");
if (!canvas) throw new Error("Missing #pond canvas");
canvas.width = innerWidth;
canvas.height = innerHeight;
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("Canvas 2D is unavailable");

const pond = createPond(canvas.width, canvas.height);
const school = spawnFish(pond, 12);

function frame(): void {
  if (!ctx) return;
  drawPond(ctx, pond);
  for (const fish of school) {
    swim(fish, pond);
    drawFish(ctx, fish);
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
