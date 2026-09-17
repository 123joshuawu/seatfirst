// Focused unit tests for scripts/cleanup-dangling-chrome.mjs's edge cases. Run directly by
// `vitest.config.scripts.ts` (see root `pnpm test:scripts`) — not part of any package's own
// vitest project, since this script sits outside packages/*.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findOrphans,
  isAlive,
  killGroup,
  listProcesses,
  main,
} from "./cleanup-dangling-chrome.mjs";

function fakeExec(output) {
  return () => output;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("listProcesses", () => {
  it("parses ps rows into {pid, ppid, command}, keeping commands with spaces and dropping malformed lines", () => {
    const out = [
      "  PID  PPID COMMAND",
      "  101     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=x",
      "garbage line without numbers",
      "  202   101 some helper process with    internal spaces",
      "",
      "  abc   1 not-a-pid",
      "  303     1 single",
    ].join("\n");
    expect(listProcesses(fakeExec(out))).toEqual([
      {
        pid: 101,
        ppid: 1,
        command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=x",
      },
      { pid: 202, ppid: 101, command: "some helper process with    internal spaces" },
      { pid: 303, ppid: 1, command: "single" },
    ]);
  });

  it("returns an empty array when ps output has only the header", () => {
    expect(listProcesses(fakeExec("  PID  PPID COMMAND\n"))).toEqual([]);
  });
});

describe("findOrphans", () => {
  // Two different tmpdir bases — a per-user macOS login-session tmpdir and the plain
  // "/tmp" a launchd/agent job falls back to when $TMPDIR is unset. Orphans must be
  // caught under either, since matching is on the profile dir's basename, not a path
  // anchored to this test process's own os.tmpdir().
  const macTmpPrefix = "/var/folders/m3/nk963dqx0pq264jlpx3m846m0000gn/T/seatfirst-chrome-";
  const plainTmpPrefix = "/tmp/seatfirst-chrome-";
  const orphanCommand = `chrome --user-data-dir=${macTmpPrefix}12345`;
  const otherTmpdirOrphanCommand = `chrome --user-data-dir=${plainTmpPrefix}67890`;
  const out = [
    "  PID  PPID COMMAND",
    // orphan: reparented to PID 1 AND using a seatfirst-chrome profile
    `  501     1 ${orphanCommand}`,
    // orphan under a different tmpdir base — basename match still catches it
    `  505     1 ${otherTmpdirOrphanCommand}`,
    // ppid 1 but unrelated command → not an orphan
    "  502     1 launchd keepalive something-unrelated",
    // seatfirst profile but live parent (a run in progress) → not an orphan
    `  503   400 chrome --user-data-dir=${macTmpPrefix}99999`,
    // neither condition → not an orphan
    "  504   500 regular chrome instance",
  ].join("\n");

  it("returns entries with ppid 1 AND a user-data-dir basename starting with seatfirst-chrome-, regardless of tmpdir base", () => {
    expect(findOrphans(fakeExec(out))).toEqual([
      { pid: 501, ppid: 1, command: orphanCommand },
      { pid: 505, ppid: 1, command: otherTmpdirOrphanCommand },
    ]);
  });

  it("requires BOTH conditions — an entry matching just one is excluded", () => {
    const orphans = findOrphans(fakeExec(out));
    expect(orphans.some((entry) => entry.pid === 502)).toBe(false);
    expect(orphans.some((entry) => entry.pid === 503)).toBe(false);
  });
});

describe("isAlive", () => {
  it("returns true when process.kill(pgid, 0) succeeds", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {});
    expect(isAlive(4242)).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(-4242, 0);
  });

  it("returns false when process.kill(pgid, 0) throws", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(isAlive(4242)).toBe(false);
  });
});

describe("killGroup", () => {
  function mockKillThatDiesAfterFirstProbe() {
    let zeroProbes = 0;
    return vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        zeroProbes += 1;
        if (zeroProbes > 1) throw new Error("ESRCH");
        return;
      }
      return;
    });
  }

  it("sends SIGTERM and no SIGKILL when the group dies during the grace period", async () => {
    vi.useFakeTimers();
    const kill = mockKillThatDiesAfterFirstProbe();

    const done = killGroup(7001);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    const signals = kill.mock.calls.map(([, signal]) => signal);
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
    // First liveness probe saw it alive, second (after one 200ms poll) saw it gone.
    expect(kill.mock.calls.filter(([, signal]) => signal === 0)).toHaveLength(3);
  });

  it("escalates to SIGKILL when the group survives the whole grace period", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {});

    const done = killGroup(7002);
    await vi.advanceTimersByTimeAsync(3000 + 200);
    await done;

    const signals = kill.mock.calls.map(([, signal]) => signal);
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });

  it("returns silently when the initial SIGTERM itself throws (already gone)", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });

    await killGroup(7003);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill.mock.calls[0][1]).toBe("SIGTERM");
  });
});

describe("main", () => {
  it("smoke: finds orphans via injected exec and tears down each process group without throwing", async () => {
    vi.useFakeTimers();
    const orphanCommand = "chrome --user-data-dir=/tmp/seatfirst-chrome-777";
    const exec = fakeExec(["  PID  PPID COMMAND", `  801     1 ${orphanCommand}`].join("\n"));
    // Group dies on the first liveness probe → teardown completes after SIGTERM alone.
    let probed = false;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        if (probed) throw new Error("ESRCH");
        probed = true;
      }
      return;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const done = main(exec);
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toBeUndefined();

    expect(process.kill).toHaveBeenCalledWith(-801, "SIGTERM");
    expect(process.kill).not.toHaveBeenCalledWith(-801, "SIGKILL");
  });
});
