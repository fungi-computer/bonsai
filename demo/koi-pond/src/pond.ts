export type Vec = { x: number; y: number };

export type Pond = {
  width: number;
  height: number;
  pads: Vec[];
};

export function createPond(width: number, height: number): Pond {
  const pads = Array.from({ length: 6 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
  }));
  return { width, height, pads };
}

export function drawPond(ctx: CanvasRenderingContext2D, pond: Pond): void {
  ctx.fillStyle = "#0b3d4f";
  ctx.fillRect(0, 0, pond.width, pond.height);
  ctx.fillStyle = "#3f8f4a";
  for (const pad of pond.pads) {
    ctx.beginPath();
    ctx.arc(pad.x, pad.y, 22, 0.3, Math.PI * 2);
    ctx.lineTo(pad.x, pad.y);
    ctx.fill();
  }
}
