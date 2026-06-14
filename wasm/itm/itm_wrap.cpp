// extern "C" entry point around SPLAT's classic ITM (Longley-Rice) propagation core.
//
// We compile the whole, self-contained splat/itwom3.0.cpp (it pulls in only <math.h>/<complex>/
// <assert.h>/<string.h> and defines its own structs — no SPLAT, no file I/O, no SDF/page arrays)
// and export ONLY this wrapper. Dead-code elimination then strips everything reachable solely from
// the unused ITWOM entry point (point_to_point / area / …), so the .wasm carries just the ITM path
// we actually call. This is deliberately the whole-file-compile approach rather than hand-extracting
// functions: zero surgery risk, identical numbers to the server's `splat -olditm`.
//
// The browser builds the terrain profile itself (from the same Terrarium tiles the map draws) and
// hands us SPLAT's elev[] layout directly, so we inherit none of SPLAT's 30/90 m or 250/500 km caps
// — the only limit is how many profile points we choose to sample.

#include <math.h>
#include <string.h>

// itwom3.0.cpp publishes no header; mirror splat.cpp's own prototype for the classic-ITM entry.
// Signature must match exactly for the C++ linker to resolve it against itwom3.0.cpp.
void point_to_point_ITM(double elev[], double tht_m, double rht_m, double eps_dielect,
                        double sgm_conductivity, double eno_ns_surfref, double frq_mhz,
                        int radio_climate, int pol, double conf, double rel, double &dbloss,
                        char *strmode, int &errnum);

extern "C" {

// One point-to-point ITM evaluation.
//
//   elev  : SPLAT's profile array, built JS-side in the WASM heap:
//             elev[0] = (number of profile points) - 1
//             elev[1] = spacing between points, metres (great-circle ground distance)
//             elev[2..] = ground elevations, metres ASL (RAW — ITM applies earth curvature itself;
//                         do NOT pre-sag the terrain)
//   tht_m, rht_m       : TX / RX antenna heights AGL, metres
//   eps_dielect        : ground dielectric constant   (request.ground_dielectric)
//   sgm_conductivity   : ground conductivity S/m       (request.ground_conductivity)
//   eno_ns_surfref     : surface refractivity, N-units  (request.atmosphere_bending)
//   frq_mhz            : frequency, MHz
//   radio_climate      : 1..7 (see point_to_point_ITM doc)
//   pol                : 0 = horizontal, 1 = vertical
//   conf, rel          : confidence / reliability fractions 0.01..0.99
//                        (situation_fraction/100, time_fraction/100)
//   out                : caller-provided array, length >= 4, filled with
//                        [0]=total path loss dB, [1]=free-space loss dB, [2]=distance m, [3]=errnum
//
// Returns total path loss in dB (== out[0]; point_to_point_ITM already adds free space to avar()).
double itm_p2p(double *elev, double tht_m, double rht_m, double eps_dielect,
               double sgm_conductivity, double eno_ns_surfref, double frq_mhz, int radio_climate,
               int pol, double conf, double rel, double *out) {
  double dbloss = 0.0;
  int errnum = 0;
  char strmode[128];
  strmode[0] = '\0';

  point_to_point_ITM(elev, tht_m, rht_m, eps_dielect, sgm_conductivity, eno_ns_surfref, frq_mhz,
                     radio_climate, pol, conf, rel, dbloss, strmode, errnum);

  // distance = (num points - 1) * spacing — matches prop.dist that ITM derives internally.
  const double dist_m = elev[0] * elev[1];
  const double dist_km = dist_m / 1000.0;
  const double fs = (dist_km > 0.0) ? (32.45 + 20.0 * log10(frq_mhz) + 20.0 * log10(dist_km)) : 0.0;

  if (out) {
    out[0] = dbloss;
    out[1] = fs;
    out[2] = dist_m;
    out[3] = (double)errnum;
  }
  return dbloss;
}

}  // extern "C"
