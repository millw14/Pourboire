import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';
import QRCode from 'qrcode';
import { verifyReceipt, type ReceiptParams } from '@/lib/receipt';

/**
 * The card attached to every bot reply.
 *
 * Replaces a plain-text sentence that nobody screenshots. Rendering is gated on
 * an HMAC so this cannot be used to manufacture convincing fake receipts.
 *
 * It also carries every URL the bot would otherwise put in the tweet: X does not
 * parse text inside an image, so an address rendered here costs nothing, while
 * the same string in the tweet body moves the post from $0.015 to $0.20.
 */

export const runtime = 'nodejs';

const WIDTH = 1200;
const HEIGHT = 630;

const BADGES: Record<ReceiptParams['kind'], string> = {
  tip: 'Tip sent',
  giveaway: 'Giveaway paid',
  wallet: 'Tip wallet',
  stats: 'Tips received',
  help: 'Commands',
};

export async function GET(req: NextRequest) {
  const params = verifyReceipt(req.nextUrl.searchParams);
  if (!params) {
    return new Response('Not found', { status: 404 });
  }

  // Generated before rendering because the JSX tree satori receives has to be
  // synchronous. PNG rather than SVG: satori's SVG-in-img support is patchier
  // than its PNG handling, and this is the one asset that must not fail to draw.
  let qrDataUri: string | null = null;
  if (params.kind === 'wallet' && params.qr) {
    try {
      const png = await QRCode.toBuffer(`ethereum:${params.qr}@4663`, {
        type: 'png',
        margin: 1,
        width: 260,
        color: { dark: '#000000ff', light: '#ffffffff' },
      });
      qrDataUri = `data:image/png;base64,${png.toString('base64')}`;
    } catch {
      // A missing QR degrades the card; it does not break it. The address is
      // rendered as text alongside regardless.
      qrDataUri = null;
    }
  }

  return new ImageResponse(<Card params={params} qrDataUri={qrDataUri} />, {
    width: WIDTH,
    height: HEIGHT,
    headers: {
      // Immutable: the signature covers every input, so a given URL always
      // renders the same card.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

function Card({ params, qrDataUri }: { params: ReceiptParams; qrDataUri: string | null }) {
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
      <Header params={params} />
      <Body params={params} qrDataUri={qrDataUri} />
      <Footer params={params} />
    </div>
  );
}

function Header({ params }: { params: ReceiptParams }) {
  return (
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
        {BADGES[params.kind]}
      </div>
    </div>
  );
}

function Body({ params, qrDataUri }: { params: ReceiptParams; qrDataUri: string | null }) {
  if (params.kind === 'wallet') return <WalletBody params={params} qrDataUri={qrDataUri} />;
  if (params.kind === 'stats' || params.kind === 'help') return <ListBody params={params} />;
  return <AmountBody params={params} />;
}

/** Tip and giveaway: the amount is the headline. */
function AmountBody({ params }: { params: ReceiptParams }) {
  const isGiveaway = params.kind === 'giveaway';
  return (
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
  );
}

/**
 * Wallet: whose it is, the address in full, and a scannable code.
 *
 * The address is split across two lines rather than shrunk to fit — an
 * address someone might retype by hand has to stay legible.
 */
function WalletBody({ params, qrDataUri }: { params: ReceiptParams; qrDataUri: string | null }) {
  const address = params.qr ?? '';
  const half = Math.ceil(address.length / 2);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 48 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, flex: 1 }}>
        <div style={{ display: 'flex', fontSize: 46, fontWeight: 300, letterSpacing: -1 }}>
          {params.to}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            fontSize: 27,
            fontFamily: 'monospace',
            color: params.color,
            lineHeight: 1.45,
          }}
        >
          <span style={{ display: 'flex' }}>{address.slice(0, half)}</span>
          <span style={{ display: 'flex' }}>{address.slice(half)}</span>
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 24,
            fontWeight: 300,
            color: 'rgba(255,255,255,0.5)',
          }}
        >
          Send USDG or any token on Robinhood Chain
        </div>
      </div>

      {/* This tree is rendered by satori into a PNG, not by the browser.
          next/image does not exist in that renderer, and the source is an
          inline data URI, so there is nothing to optimise. */}
      {qrDataUri && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={qrDataUri}
          width={260}
          height={260}
          alt=""
          style={{ borderRadius: 12, background: '#ffffff' }}
        />
      )}
    </div>
  );
}

/** Stats and help: a short list, one item per line. */
function ListBody({ params }: { params: ReceiptParams }) {
  // Capped at six so long lists shrink the type rather than overflowing the card.
  const lines = (params.lines ?? '').split('\n').filter(Boolean).slice(0, 6);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, paddingTop: 8 }}>
      {params.to && (
        <div
          style={{
            display: 'flex',
            fontSize: 44,
            fontWeight: 300,
            letterSpacing: -1,
            marginBottom: 6,
          }}
        >
          {params.to}
        </div>
      )}
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            fontSize: lines.length > 4 ? 30 : 36,
            fontWeight: 300,
            color: i === 0 && params.kind === 'stats' ? params.color : 'rgba(255,255,255,0.85)',
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

function Footer({ params }: { params: ReceiptParams }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div
        style={{
          display: 'flex',
          fontSize: 22,
          fontWeight: 300,
          color: 'rgba(255,255,255,0.55)',
        }}
      >
        {params.footer ?? 'pourboire.tips'}
      </div>
      {params.tx && (
        <div
          style={{
            display: 'flex',
            fontSize: 20,
            fontFamily: 'monospace',
            color: 'rgba(255,255,255,0.4)',
          }}
        >
          {params.tx}
        </div>
      )}
    </div>
  );
}
