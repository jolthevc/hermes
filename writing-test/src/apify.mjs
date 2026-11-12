// Gold-reference shortlist via Apify (metadata only: links + stats, no media or transcripts).
//   node src/apify.mjs profiles <handle> <handle> ...        check handles exist, follower counts
//   node src/apify.mjs reels --per 30 <handle> <handle> ...  pull recent reels, rank, write out/gold-shortlist.*
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) throw new Error("APIFY_TOKEN is not set");

fs.mkdirSync("out", { recursive: true });

async function runActor(actor, input) {
  const res = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=300`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify ${actor} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

const [cmd, ...rest] = process.argv.slice(2);
let per = 30;
const handles = [];
for (let i = 0; i < rest.length; i++) rest[i] === "--per" ? (per = +rest[++i]) : handles.push(rest[i].replace(/^@/, ""));

if (cmd === "profiles") {
  const items = await runActor("apify~instagram-profile-scraper", { usernames: handles });
  for (const p of items) console.log(`${(p.username ?? "?").padEnd(28)} followers=${p.followersCount ?? "?"}  posts=${p.postsCount ?? "?"}  ${p.error ?? ""} ${(p.biography ?? "").replace(/\s+/g, " ").slice(0, 70)}`);
  fs.writeFileSync("out/apify-profiles.json", JSON.stringify(items, null, 2));
} else if (cmd === "reels") {
  const items = await runActor("apify~instagram-reel-scraper", { username: handles, resultsLimit: per });
  fs.writeFileSync("out/apify-reels-raw.json", JSON.stringify(items, null, 2));
  const reels = items
    .filter((r) => r.url && (r.videoPlayCount ?? r.videoViewCount))
    .map((r) => ({
      account: r.ownerUsername,
      url: r.url,
      posted: (r.timestamp ?? "").slice(0, 10),
      seconds: r.videoDuration ? Math.round(r.videoDuration) : null,
      plays: r.videoPlayCount ?? r.videoViewCount,
      likes: r.likesCount ?? 0,
      comments: r.commentsCount ?? 0,
      caption: (r.caption ?? "").replace(/\s+/g, " ").slice(0, 90),
    }));
  // Rank within each account by plays relative to that account's median (so big accounts don't swamp the list),
  // and keep only reels in our length range.
  const byAcct = {};
  for (const r of reels) (byAcct[r.account] ??= []).push(r);
  for (const rs of Object.values(byAcct)) {
    const sorted = rs.map((r) => r.plays).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    for (const r of rs) { r.x_median = +(r.plays / median).toFixed(1); r.like_rate = +((r.likes / r.plays) * 100).toFixed(2); }
  }
  const inRange = reels.filter((r) => r.seconds == null || (r.seconds >= 12 && r.seconds <= 60));
  const ranked = inRange.sort((a, b) => b.x_median - a.x_median || b.plays - a.plays);
  fs.writeFileSync("out/gold-shortlist.json", JSON.stringify(ranked, null, 2));
  console.log(`${reels.length} reels pulled, ${inRange.length} in 12-60s range\n`);
  for (const r of ranked.slice(0, 25)) console.log(`${r.account.padEnd(20)} ${String(r.seconds ?? "?").padStart(3)}s  plays=${String(r.plays).padStart(10)}  x${r.x_median} vs acct median  like%=${r.like_rate}  ${r.url}`);
} else {
  console.log("usage: node src/apify.mjs profiles|reels [--per N] <handles...>");
}
