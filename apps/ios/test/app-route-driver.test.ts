import { describe, expect, test } from '@jest/globals';

import { ROUTE_DRIVER_MARKERS, driveRoutes } from '../src/app/route-driver';

interface Recorder {
  visited: string[];
  logged: Array<{ category: string; message: string }>;
  waits: number[];
}

function ports(routes: string[], navigate?: (route: string) => void) {
  const recorder: Recorder = { visited: [], logged: [], waits: [] };
  return {
    recorder,
    driver: {
      routes,
      dwellMs: 50,
      navigate: (route: string) => {
        if (navigate) navigate(route);
        recorder.visited.push(route);
      },
      log: (category: string, message: string) => {
        recorder.logged.push({ category, message });
      },
      wait: async (ms: number) => {
        recorder.waits.push(ms);
      },
    },
  };
}

describe('launch route driver', () => {
  test('does nothing at all when no routes were handed in', async () => {
    // This is every normal launch. Nothing can set the environment variable on
    // an App Store launch, so the path has to be inert rather than merely idle.
    const { recorder, driver } = ports([]);

    await expect(driveRoutes(driver)).resolves.toBe(0);

    expect(recorder.visited).toEqual([]);
    expect(recorder.logged).toEqual([]);
  });

  test('walks the routes in order, holding each one', async () => {
    const { recorder, driver } = ports(['/', '/scan', '/settings']);

    await expect(driveRoutes(driver)).resolves.toBe(3);

    expect(recorder.visited).toEqual(['/', '/scan', '/settings']);
    expect(recorder.waits).toEqual([50, 50, 50]);
  });

  test('announces a route before opening it', async () => {
    // The point of the ordering: if opening a route takes the process down,
    // the last line written names the route that did it. Logging afterwards
    // would leave the crash anonymous.
    const { recorder, driver } = ports(['/scan'], (route) => {
      const announced = recorder.logged.some(
        (entry) => entry.category === ROUTE_DRIVER_MARKERS.visiting && entry.message === route,
      );
      expect(announced).toBe(true);
    });

    await driveRoutes(driver);
  });

  test('a route that throws is reported, and the walk continues', async () => {
    // One unreachable route must not hide the state of the ones after it.
    const { recorder, driver } = ports(['/ok', '/broken', '/after'], (route) => {
      if (route === '/broken') throw new Error('no such route');
    });

    await expect(driveRoutes(driver)).resolves.toBe(2);

    expect(recorder.visited).toEqual(['/ok', '/after']);
    const failures = recorder.logged.filter((entry) => entry.category === ROUTE_DRIVER_MARKERS.failed);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('/broken');
  });

  test('reports how many of the routes it reached', async () => {
    const { recorder, driver } = ports(['/a', '/b', '/c'], (route) => {
      if (route === '/b') throw new Error('nope');
    });

    await driveRoutes(driver);

    const finished = recorder.logged.find((entry) => entry.category === ROUTE_DRIVER_MARKERS.finished);
    expect(finished?.message).toBe('2/3');
    const started = recorder.logged.find((entry) => entry.category === ROUTE_DRIVER_MARKERS.started);
    expect(started?.message).toBe('3');
  });
});
