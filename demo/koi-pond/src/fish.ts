import type { Pond, Vec } from "./pond.js";

export type Fish = { position: Vec; heading: number; speed: number };

export function spawnFish(pond: Pond, count: number): Fish[] {
  return Array.from({ length: count }, () => ({
    position: { x: Math.random() * pond.width, y: Math.random() * pond.height },
    heading: Math.random() * Math.PI * 2,
    speed: 0.6 + Math.random() * 0.8,
  }));
}

export function swim(fish: Fish, pond: Pond): void {
  fish.heading += (Math.random() - 0.5) * 0.2;
  fish.position.x =
    (fish.position.x + Math.cos(fish.heading) * fish.speed + pond.width) %
    pond.width;
  fish.position.y =
    (fish.position.y + Math.sin(fish.heading) * fish.speed + pond.height) %
    pond.height;
}

export function drawFish(ctx: CanvasRenderingContext2D, fish: Fish): void {
  ctx.save();
  ctx.translate(fish.position.x, fish.position.y);
  ctx.rotate(fish.heading);
  ctx.fillStyle = "#f2994a";
  ctx.beginPath();
  ctx.ellipse(0, 0, 10, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
