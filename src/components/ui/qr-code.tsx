'use client';

import { useMemo } from 'react';
import QRCode from 'qrcode';

/**
 * Renders a payment QR locally, as inline SVG.
 *
 * The Fund dialog previously linked out to `api.qrserver.com` with the user's
 * wallet address in the query string — which handed a third party a record of
 * every address, and only worked if you opened a new tab to look at it.
 */

interface QrCodeProps {
  /** Usually an EIP-681 `ethereum:` URI. */
  value: string;
  size?: number;
  label: string;
}

export function QrCode({ value, size = 176, label }: QrCodeProps) {
  const modules = useMemo(() => {
    try {
      // Medium correction: still scannable with the logo-free quiet zone we use,
      // without inflating the module count for long URIs.
      const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
      return { data: qr.modules.data, size: qr.modules.size };
    } catch {
      return null;
    }
  }, [value]);

  if (!modules) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex items-center justify-center rounded-lg bg-white/5 text-center text-xs text-white/50"
      >
        QR unavailable
      </div>
    );
  }

  const quiet = 2;
  const total = modules.size + quiet * 2;

  // One path for every dark module beats one <rect> each — a 41x41 code is
  // ~800 elements otherwise.
  let path = '';
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (modules.data[y * modules.size + x]) {
        path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="rounded-lg bg-white p-0"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
