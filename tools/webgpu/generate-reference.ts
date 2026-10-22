import { mkdirSync, writeFileSync } from 'node:fs';
import { runCoverageCpu } from '../../apps/web/src/compute/coverage/kernel-cpu.js';
import { FIXTURE_VERSION, FIXTURE_NAMES, FIXTURE_CAMERA, makeFixture, outputHashes, rgba } from './fixtures.js';
const references: Record<string, unknown> = {};
mkdirSync('fixtures/webgpu', { recursive: true });
for (const name of FIXTURE_NAMES) {
  const input = makeFixture(name);
  const out = await runCoverageCpu(input);
  references[name] = { hashes: await outputHashes(out), counts: out.counts, marginsMillidb: Array.from(out.margins, (v) => Number.isFinite(v) ? Math.round(v * 1000) : null) };
  // Lossless PAM reference pixels; browser tests also write viewable PNGs.
  const header = `P7\nWIDTH ${input.geometry.width}\nHEIGHT ${input.geometry.height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
  writeFileSync(`fixtures/webgpu/${name}.pam`, Buffer.concat([Buffer.from(header), Buffer.from(rgba(out.codes))]));
}
const serialized = JSON.stringify({ version: FIXTURE_VERSION, camera: FIXTURE_CAMERA, references }, null, 2)
  .replace(/"marginsMillidb": \[([\s\S]*?)\]/g, (_match, contents: string) => {
    const values: Array<number | null> = JSON.parse(`[${contents}]`);
    const rows = Array.from({ length: Math.ceil(values.length / 32) }, (_, i) =>
      '        ' + values.slice(i * 32, (i + 1) * 32).map((v) => JSON.stringify(v)).join(', '));
    return '"marginsMillidb": [\n' + rows.join(',\n') + '\n      ]';
  });
writeFileSync('fixtures/webgpu/references.json', serialized + '\n');
console.log(`Wrote ${FIXTURE_NAMES.length} CPU reference renders and hashes.`);
