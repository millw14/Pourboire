import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';
import { verifyReceipt, type ReceiptParams } from '@/lib/receipt';

/**
 * The receipt card attached to every bot reply.
 *
 * Replaces a plain-text sentence that nobody screenshots. Rendering is gated on
 * an HMAC so this cannot be used to manufacture convincing fake receipts.
 */

export const runtime = 'nodejs';

const WIDTH = 1200;
const HEIGHT = 630;

export async function GET(req: NextRequest) {
  const params = verifyReceipt(req.nextUrl.searchParams);
  if (!params) {
    return new Response('Not found', { status: 404 });
  }

  return new ImageResponse(<Card {...params} />, {
    width: WIDTH,
    height: HEIGHT,
    headers: {
      // Immutable: the signature covers every input, so a given URL always
      // renders the same card.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

function Card(params: ReceiptParams) {
  const isGiveaway = params.kind === 'giveaway';

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 64,
        background: '#050505',
        // A wash of the token's colour, so a BONK tip reads differently from a
        // USDC one at a glance while scrolling.
        backgroundImage: `radial-gradient(900px 500px at 15% 0%, ${params.color}26 0%, transparent 60%), radial-gradient(700px 500px at 100% 100%, ${params.color}1a 0%, transparent 55%)`,
        color: '#ffffff',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              width: 44,
              height: 44,
              borderRadius: 22,
              background: params.color,
            }}
          />
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 300, letterSpacing: -0.5 }}>
            Pourboire
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            padding: '10px 22px',
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.14)',
            fontSize: 22,
            fontWeight: 300,
            color: 'rgba(255,255,255,0.75)',
          }}
        >
          {isGiveaway ? 'Giveaway paid' : 'Tip sent'}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div
          style={{
            display: 'flex',
            fontSize: 108,
            fontWeight: 700,
            letterSpacing: -3,
            color: params.color,
            lineHeight: 1,
          }}
        >
          {params.amount}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            fontSize: 40,
            fontWeight: 300,
            color: 'rgba(255,255,255,0.92)',
          }}
        >
          <span style={{ display: 'flex' }}>{params.from}</span>
          <span style={{ display: 'flex', color: 'rgba(255,255,255,0.35)' }}>→</span>
          <span style={{ display: 'flex' }}>
            {isGiveaway && params.winners
              ? `${params.winners} winner${params.winners === 1 ? '' : 's'}`
              : params.to}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div
          style={{
            display: 'flex',
            fontSize: 22,
            fontWeight: 300,
            color: 'rgba(255,255,255,0.45)',
          }}
        >
          pourboire.tips
        </div>
        {params.tx && (
          <div
            style={{
              display: 'flex',
              fontSize: 20,
              fontFamily: 'monospace',
              color: 'rgba(255,255,255,0.35)',
            }}
          >
            {params.tx}
          </div>
        )}
      </div>
    </div>
  );
}
