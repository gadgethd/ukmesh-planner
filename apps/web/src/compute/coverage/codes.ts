/** Cell classification codes shared by CPU kernel, GPU shader and renderer. */
export const CELL_LIKELY = 0;
export const CELL_MARGINAL = 1;
export const CELL_UNLIKELY = 2;
export const CELL_BLOCKED = 3;
export const CELL_UNKNOWN = 4;
export const CELL_OUT_OF_RANGE = 5;

export const CODE_LABEL: Record<number, string> = {
  0: 'likely',
  1: 'marginal',
  2: 'unlikely',
  3: 'blocked',
  4: 'unknown-terrain',
  5: 'out of range',
};

/** RGBA fill per code (rendered as a semi-transparent overlay). */
export const CODE_RGBA: Record<number, [number, number, number, number]> = {
  0: [21, 128, 61, 150],
  1: [217, 119, 6, 150],
  2: [148, 163, 184, 80],
  3: [220, 38, 38, 110],
  4: [147, 51, 234, 90],
  5: [0, 0, 0, 0],
};
