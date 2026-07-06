import { useEffect, useRef } from "react";
import { cssToken, withAlpha } from "../lib/cssTokens";

interface Props {
  lat: number;
  lng: number;
  onPick: (lat: number, lng: number) => void;
}

const W = 720;
const H = 360;

type LineRun = number[][];

// One fetch for every picker on the page.
let ringsPromise: Promise<LineRun[]> | null = null;
const loadRings = () => {
  ringsPromise ??= fetch("/geo/land-rings.json")
    .then((res) => (res.ok ? res.json() : { rings: [] }))
    .then((data: { rings?: LineRun[] }) => data.rings ?? [])
    .catch(() => []);
  return ringsPromise;
};

const toX = (lng: number) => ((lng + 180) / 360) * W;
const toY = (lat: number) => ((90 - lat) / 180) * H;

/**
 * Equirectangular click-to-place picker drawn from the site's own
 * coastline data. Click anywhere to set the pin; the inputs next to it
 * stay authoritative for fine-tuning.
 */
export function MapPicker({ lat, lng, onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRings().then((rings) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (cancelled || !canvas || !ctx) return;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = cssToken("--globe-ocean");
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = withAlpha(cssToken("--accent"), 0.55);
      ctx.lineWidth = 0.6;
      for (const ring of rings) {
        ctx.beginPath();
        for (let i = 0; i < ring.length; i++) {
          const x = toX(ring[i][0]);
          const y = toY(ring[i][1]);
          // Skip segments that would streak across an antimeridian wrap.
          if (i === 0 || Math.abs(ring[i][0] - ring[i - 1][0]) > 180) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // Crosshair on the current pin.
      const px = toX(lng);
      const py = toY(lat);
      ctx.strokeStyle = cssToken("--accent-hot");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px - 8, py);
      ctx.lineTo(px + 8, py);
      ctx.moveTo(px, py - 8);
      ctx.lineTo(px, py + 8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.stroke();
    });
    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  return (
    <canvas
      ref={canvasRef}
      className="map-picker"
      width={W}
      height={H}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * W;
        const y = ((event.clientY - rect.top) / rect.height) * H;
        const pickedLng = Math.round(((x / W) * 360 - 180) * 10000) / 10000;
        const pickedLat = Math.round((90 - (y / H) * 180) * 10000) / 10000;
        onPick(pickedLat, pickedLng);
      }}
      title="Click to place the pin"
    />
  );
}
