// solver.js — the numeric heart of parametric sketching.
//
// A constraint sketch is just a system of nonlinear equations: every constraint
// contributes one or more residuals that should be zero when the constraint is
// satisfied. Solving the sketch means finding the variable vector (all point
// coordinates and circle radii) that drives every residual to zero, while
// staying as close as possible to where the user actually dragged things.
//
// We use Levenberg-Marquardt: Gauss-Newton when it is converging well, gradient
// descent when it is not. It is the standard choice for this problem because
// sketch systems are small (tens of variables), often rank-deficient (an
// under-constrained sketch has free degrees of freedom by definition), and the
// damping term is what keeps a rank-deficient system from blowing up.
//
// Everything here is plain numbers, no THREE and no DOM, so it runs headless
// under Bun and is tested that way.

// ---------------------------------------------------------------- linear algebra

// Solve A x = b for a dense square system, Gaussian elimination with partial
// pivoting. A is an array of row arrays and is consumed in place. Returns null
// if the matrix is singular past recovery, which the caller answers by raising
// the damping and trying again.
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x.every(Number.isFinite) ? x : null;
}

// Numeric rank by row reduction with a relative tolerance. Used for the degree
// of freedom read-out (under / fully / over constrained), not for solving.
export function matrixRank(rows, tol = 1e-7) {
  if (!rows.length) return 0;
  const M = rows.map((r) => [...r]);
  const nr = M.length, nc = M[0].length;
  let maxAbs = 0;
  for (const r of M) for (const v of r) maxAbs = Math.max(maxAbs, Math.abs(v));
  if (maxAbs === 0) return 0;
  const eps = tol * maxAbs;
  let rank = 0;
  for (let col = 0; col < nc && rank < nr; col++) {
    let piv = -1, best = eps;
    for (let r = rank; r < nr; r++) {
      if (Math.abs(M[r][col]) > best) { best = Math.abs(M[r][col]); piv = r; }
    }
    if (piv < 0) continue;
    const t = M[piv]; M[piv] = M[rank]; M[rank] = t;
    const d = M[rank][col];
    for (let r = 0; r < nr; r++) {
      if (r === rank) continue;
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < nc; c++) M[r][c] -= f * M[rank][c];
    }
    rank++;
  }
  return rank;
}

// ---------------------------------------------------------------- jacobian

// Forward-difference Jacobian. Analytic derivatives would be faster, but the
// constraint set is open-ended and a wrong hand-derived gradient is a brutal
// bug to find. At this problem size the numeric version is imperceptible.
export function numericJacobian(x, residualFn, m) {
  const n = x.length;
  const J = Array.from({ length: m }, () => new Array(n).fill(0));
  const probe = [...x];
  for (let j = 0; j < n; j++) {
    const h = 1e-7 * Math.max(1, Math.abs(x[j]));
    probe[j] = x[j] + h;
    const rPlus = residualFn(probe);
    probe[j] = x[j] - h;
    const rMinus = residualFn(probe);
    probe[j] = x[j];
    const inv = 1 / (2 * h);
    for (let i = 0; i < m; i++) J[i][j] = (rPlus[i] - rMinus[i]) * inv;
  }
  return J;
}

function norm2(v) { let s = 0; for (const t of v) s += t * t; return s; }
function normInf(v) { let s = 0; for (const t of v) s = Math.max(s, Math.abs(t)); return s; }

// ---------------------------------------------------------------- the solver

/**
 * Levenberg-Marquardt least squares.
 *
 * @param {number[]} x0        starting guess, normally where the user left the geometry
 * @param {(x:number[])=>number[]} residualFn
 * @param {object} opts        { maxIter, tol, lambda0 }
 * @returns {{x:number[], ok:boolean, iters:number, residual:number, reason:string}}
 */
export function solveLM(x0, residualFn, opts = {}) {
  const maxIter = opts.maxIter ?? 120;
  const tol = opts.tol ?? 1e-9;
  let lambda = opts.lambda0 ?? 1e-3;

  let x = [...x0];
  let r = residualFn(x);
  const m = r.length;
  const n = x.length;

  if (m === 0 || n === 0) {
    return { x, ok: true, iters: 0, residual: 0, reason: 'nothing to solve' };
  }

  let cost = norm2(r);
  let iters = 0;

  for (; iters < maxIter; iters++) {
    if (normInf(r) < tol) {
      return { x, ok: true, iters, residual: normInf(r), reason: 'converged' };
    }

    const J = numericJacobian(x, residualFn, m);

    // Normal equations: (J'J + lambda * diag(J'J)) d = -J'r
    const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
    const Jtr = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      const Ji = J[i], ri = r[i];
      for (let a = 0; a < n; a++) {
        if (Ji[a] === 0) continue;
        Jtr[a] += Ji[a] * ri;
        for (let b = a; b < n; b++) JtJ[a][b] += Ji[a] * Ji[b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) JtJ[a][b] = JtJ[b][a];

    let stepped = false;
    // Try progressively heavier damping until the step actually helps. Heavy
    // damping degenerates to a small gradient step, which always helps a little.
    for (let attempt = 0; attempt < 12; attempt++) {
      const A = JtJ.map((row, a) => {
        const copy = [...row];
        // Marquardt's scaling: damp proportionally to each variable's own
        // curvature, with a floor so zero-curvature (free) variables still get
        // a well-conditioned diagonal instead of a singular row.
        copy[a] += lambda * Math.max(JtJ[a][a], 1e-9);
        return copy;
      });
      const step = solveLinear(A, Jtr.map((v) => -v));
      if (step) {
        const xNew = x.map((v, i) => v + step[i]);
        const rNew = residualFn(xNew);
        const costNew = norm2(rNew);
        if (costNew < cost) {
          x = xNew; r = rNew; cost = costNew;
          lambda = Math.max(lambda * 0.3, 1e-12);
          stepped = true;
          break;
        }
      }
      lambda *= 8;
    }

    if (!stepped) {
      // No damping level improved the cost. Either we are at a genuine minimum
      // (satisfied, or as satisfied as a conflicting system allows) or numerics
      // have stalled. Either way there is nothing further to gain.
      const res = normInf(r);
      return {
        x, iters, residual: res,
        ok: res < 1e-6,
        reason: res < 1e-6 ? 'converged' : 'stalled, constraints may conflict',
      };
    }
  }

  const res = normInf(r);
  return {
    x, iters, residual: res,
    ok: res < 1e-6,
    reason: res < 1e-6 ? 'converged' : 'hit the iteration limit',
  };
}
