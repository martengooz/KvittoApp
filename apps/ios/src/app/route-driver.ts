/** Markers the device smoke check watches; see `scripts/device-smoke.mjs`. */
export const ROUTE_DRIVER_MARKERS = {
  started: 'routes:started',
  visiting: 'routes:visiting',
  finished: 'routes:finished',
  failed: 'routes:failed',
} as const;

export interface RouteDriverPorts {
  /** Routes to walk, in order. Empty in every normal launch. */
  routes: string[];
  dwellMs: number;
  navigate(route: string): void;
  log(category: string, message: string): void;
  wait(ms: number): Promise<void>;
}

/**
 * Walks the app through a list of routes, one at a time.
 *
 * This is the device counterpart of `simctl openurl`. On a simulator the smoke
 * check drives routes by opening deep links from outside the process; on a
 * physical device nothing can do that - `devicectl` installs, launches and
 * screenshots, and that is the whole list. So the app drives itself, from a
 * route list handed to it in its launch environment.
 *
 * Each route is announced before it is opened, so a route that crashes the app
 * is identified by the last line in the log rather than by the absence of one.
 * A navigation that throws is reported and the walk continues: one unreachable
 * route should not hide the state of the twenty after it.
 */
export async function driveRoutes(ports: RouteDriverPorts): Promise<number> {
  if (ports.routes.length === 0) return 0;

  ports.log(ROUTE_DRIVER_MARKERS.started, String(ports.routes.length));

  let visited = 0;
  for (const route of ports.routes) {
    // Announced first. If opening this route takes the process down, this line
    // is the last one written, and it names the route that did it.
    ports.log(ROUTE_DRIVER_MARKERS.visiting, route);
    try {
      ports.navigate(route);
      visited += 1;
    } catch (error) {
      ports.log(ROUTE_DRIVER_MARKERS.failed, `${route} ${String(error)}`);
    }
    await ports.wait(ports.dwellMs);
  }

  ports.log(ROUTE_DRIVER_MARKERS.finished, `${visited}/${ports.routes.length}`);
  return visited;
}
