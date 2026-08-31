import { describe, it, expect, beforeEach } from "vitest";
import {
  markPoolUnfit, clearPoolUnfit, isPoolFit, loadPoolFitness,
} from "../../open-sse/services/proxyPoolFitness.js";
import { listProxyPoolFitness } from "../../src/lib/db/repos/proxyPoolFitnessRepo.js";

const POOL = "acc-test-pool";
const SCOPE = "acc-test-provider::model";

describe("pool fitness accumulation", () => {
  beforeEach(async () => { await clearPoolUnfit(POOL, SCOPE); });

  it("accumulates ACROSS cooldown expiry (cd habis + gagal lagi = count naik)", async () => {
    // 1st failure with an ALREADY-EXPIRED until (simulates retry after cd)
    await markPoolUnfit(POOL, SCOPE, Date.now() - 1000, "first");
    let rows = await listProxyPoolFitness(POOL);
    let r = rows.find((x) => x.scope === SCOPE);
    expect(r.failureCount).toBe(1);

    // 2nd failure after cooldown elapsed → count must be 2, cd = 10 min
    await markPoolUnfit(POOL, SCOPE, null, "second");
    rows = await listProxyPoolFitness(POOL);
    r = rows.find((x) => x.scope === SCOPE);
    expect(r.failureCount).toBe(2);
    const cdMin = (r.until - Date.now()) / 60000;
    expect(cdMin).toBeGreaterThan(9);
    expect(cdMin).toBeLessThanOrEqual(10);

    // 3rd failure keeps diagnostic count but cooldown remains ten minutes.
    await markPoolUnfit(POOL, SCOPE, null, "third");
    rows = await listProxyPoolFitness(POOL);
    r = rows.find((x) => x.scope === SCOPE);
    expect(r.failureCount).toBe(3);
    const thirdCdMin = (r.until - Date.now()) / 60000;
    expect(thirdCdMin).toBeGreaterThan(9);
    expect(thirdCdMin).toBeLessThanOrEqual(10);
  });

  it("resets only on SUCCESS (clearPoolUnfit)", async () => {
    await markPoolUnfit(POOL, SCOPE, null, "fail");
    await markPoolUnfit(POOL, SCOPE, null, "fail");
    await clearPoolUnfit(POOL, SCOPE);
    const rows = await listProxyPoolFitness(POOL);
    expect(rows.find((x) => x.scope === SCOPE)).toBeUndefined();
    // next failure starts fresh at count 1
    await markPoolUnfit(POOL, SCOPE, null, "fresh");
    const r = (await listProxyPoolFitness(POOL)).find((x) => x.scope === SCOPE);
    expect(r.failureCount).toBe(1);
  });

  it("expired entry = pool is fit again (retry allowed) while count persists", async () => {
    await markPoolUnfit(POOL, SCOPE, Date.now() - 5000, "expired");
    await loadPoolFitness(POOL);
    expect(isPoolFit(POOL, SCOPE)).toBe(true); // cd habis → boleh dicoba
    const r = (await listProxyPoolFitness(POOL)).find((x) => x.scope === SCOPE);
    expect(r.failureCount).toBe(1); // tapi hitungan tetap tersimpan
  });
});
