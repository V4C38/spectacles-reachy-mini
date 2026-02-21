// ================================================================
// Robot Animation Configuration
// ================================================================
// Edit presets here to tune robot expressiveness without touching control logic.

// Animation parameters used by RobotDriver.
export interface AnimationParams {
    liveliness: number;         // 0-2: ambient motion intensity (roll sway, head bob, body follow)
    gazeResponsiveness: number; // 0-2: gaze tracking speed and precision
    headHeight: number;         // -1 to 1: vertical head position (down to up)
    antennaActivity: number;    // 0-3: antenna wiggle intensity (drives both amplitude and speed)
    gazeWander: number;         // 0-0.2: random gaze offset in radians (0 = exact tracking)
}

// Named presets. Callers (e.g. AssistantModeTools) pass these to RobotDriver
export const PRESETS: Record<string, AnimationParams> = {
    sleeping:  { liveliness: 0.2,  gazeResponsiveness: 0.3, headHeight: -0.55, antennaActivity: 0.15, gazeWander: 0    },
    idle:      { liveliness: 1.0,  gazeResponsiveness: 0.6, headHeight:  0.5,  antennaActivity: 1.0,  gazeWander: 0    },
    listening: { liveliness: 0.7,  gazeResponsiveness: 1.0, headHeight:  0.8,  antennaActivity: 1.3,  gazeWander: 0.08 },
    speaking:  { liveliness: 0.9,  gazeResponsiveness: 1.2, headHeight:  0.8,  antennaActivity: 1.4,  gazeWander: 0.12 },
    searching: { liveliness: 0.55, gazeResponsiveness: 1.5, headHeight:  1.0,  antennaActivity: 2.0,  gazeWander: 0    },
    puppeteer: { liveliness: 1.25, gazeResponsiveness: 1.2, headHeight:  0.6,  antennaActivity: 0.8,  gazeWander: 0    },
};
