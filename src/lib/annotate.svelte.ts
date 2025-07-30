import {
  assertNotNull,
  isNotNullish,
  isNullish,
  isSortedAscending,
} from "./util";
import typia from "typia";

export type AutoBeat = {
  id: number;
  markerType: "auto";
  regionIndex: number;
  time: number;
};

export type UserBeat = {
  id: number;
  regionIndex: number;
  markerType: "user";
  isTempoChange: boolean;
  time: number;
  localBeatPeriod: number | null;
};

export type Beat = AutoBeat | UserBeat;

type Tempo =
  | { type: "tapped"; value: { meanPeriod: number; stddev: number } | null }
  | { type: "fixed"; bpm: number; phaseOffset: number };

export type TempoRegion = {
  id: number;
  index: number;
  userBeats: UserBeat[];
  autoBeats: AutoBeat[];
  startTime: number;
  endTime: number;
  offbeatsMarked: boolean;
  tempo: Tempo;
};

export const MAX_TEMPO = 300;
const MIN_BEAT_SPACING = 60 / MAX_TEMPO;

export type IAnnotate = {
  readonly regions: TempoRegion[];
  regionById: (id: number) => TempoRegion;
  addPoint: (opts: { time: number; isTempoChange: boolean }) => void;
  deletePoint: (id: number) => void;
  tryMovePoint: (
    id: number,
    toTime: number,
    what: "start" | "move" | "end",
  ) => number;
  setRegionFixedTempo: (regionId: number, bpm: number) => void;
  setRegionType: (regionId: number, type: "fixed" | "tapped") => void;
  setViewport: (v: { startTime: number; endTime: number }) => void;
  selectedRegionId: number | null;
  readonly selectedRegion: TempoRegion | null;
  save: () => SaveObject;
};

function isFixedTempo(
  region: TempoRegion,
): region is TempoRegion & { tempo: { type: "fixed" } } {
  return region.tempo.type === "fixed";
}
function isTappedTempo(
  region: TempoRegion,
): region is TempoRegion & { tempo: { type: "tapped" } } {
  return region.tempo.type === "tapped";
}

const incrementingId = () => {
  let id = 0;
  return () => {
    id += 1;
    return id;
  };
};

function setTimesBetweenBeats(
  region: TempoRegion & { tempo: { type: "tapped" } },
) {
  if (region.tempo.value === null) {
    for (const p of region.userBeats) {
      p.localBeatPeriod = null;
    }
  } else {
    const { meanPeriod: onePeriod, stddev } = region.tempo.value;
    for (let i = 0; i < region.userBeats.length; i++) {
      const beat = region.userBeats[i];
      if (i === 0) {
        beat.localBeatPeriod = null;
      } else {
        const between = beat.time - region.userBeats[i - 1].time;
        const nPeriods = Math.round(between / onePeriod);
        beat.localBeatPeriod = nPeriods > 0 ? between / nPeriods : null;
      }
    }
  }
}

function recomputePhaseOffset(
  region: TempoRegion & { tempo: { type: "fixed" } },
) {
  if (region.userBeats.length === 0) {
    console.error("region can not have 0 beats");
  } else if (region.userBeats.length < 2) {
    region.tempo.phaseOffset = 0;
  } else {
    const period = 60 / region.tempo.bpm;
    const meanError = (() => {
      let sum = 0;
      for (const [i, beat] of region.userBeats.entries()) {
        if (i === 0) {
          continue;
        }
        const t = beat.time - region.startTime;
        const nPeriods = Math.round(t / period);
        const err = nPeriods * period - t;
        sum += err;
      }
      return sum / (region.userBeats.length - 1);
    })();
    region.tempo.phaseOffset = -meanError;
  }
}

function recomputeTempo(region: TempoRegion & { tempo: { type: "tapped" } }) {
  if (region.userBeats.length === 0) {
    console.error("region can not have 0 beats");
  } else if (region.userBeats.length < 2) {
    region.tempo.value = null;
  } else {
    let dists = [];
    let minDist = Number.POSITIVE_INFINITY;
    for (let i = 1; i < region.userBeats.length; i++) {
      const dist = region.userBeats[i].time - region.userBeats[i - 1].time;
      dists.push(dist);
      minDist = Math.min(minDist, dist);
    }
    const initialEstimate = (() => {
      let candidates = [];
      let sum = 0;
      let count = 0;
      for (const dist of dists) {
        if (dist < minDist * 1.2) {
          candidates.push(dist);
        }
      }
      candidates.sort();
      if (candidates.length >= 5) {
        const discard = Math.ceil(candidates.length * 0.2);
        candidates = candidates.slice(discard, candidates.length - discard);
      }
      for (const dist of candidates) {
        sum += dist;
        count += 1;
      }
      console.assert(count >= 1);
      return sum / count;
    })();
    const meanPeriod = (() => {
      let sum = 0;
      let count = 0;
      for (const dist of dists) {
        let periods = Math.round(dist / initialEstimate);
        sum += dist;
        count += periods;
      }
      return sum / count;
    })();
    const meanBpm = 60 / meanPeriod;
    const variance = (() => {
      let sum = 0;
      let count = 0;
      for (const dist of dists) {
        const periods = Math.round(dist / initialEstimate);
        const bpm = 60 / (dist / periods);
        sum += Math.pow(meanBpm - bpm, 2);
        count += 1;
      }
      return sum / count;
    })();
    region.tempo.value = {
      meanPeriod: meanPeriod,
      stddev: Math.sqrt(variance),
    };
  }
}

export type SaveObject = {
  tempoRegions: {
    offbeatsMarked: boolean;
    tempo: { type: "fixed"; bpm: number } | { type: "tapped" };
    markedBeats: number[];
    inferredBeats: number[];
  }[];
};

export const Annotate = (opts: {
  duration: number;
  save: (obj: SaveObject) => void;
  loadSaved: SaveObject | null;
}): IAnnotate => {
  const duration = opts.duration;
  const nextRegionId = incrementingId();
  const regions: TempoRegion[] = $state([]);
  const nextUserBeatId = incrementingId();
  const nextAutoBeatId = incrementingId();
  const userBeatsById = new Map<number, UserBeat>();
  let viewport = { startTime: 0, endTime: 0 };
  let selectedRegionId: number | null = $state(null);

  const reassignRegionIndices = () => {
    for (let i = 0; i < regions.length; i++) {
      regions[i].index = i;
      for (let j = 0; j < regions[i].userBeats.length; j++) {
        regions[i].userBeats[j].regionIndex = i;
      }
    }
  };

  const onRegionsChanged = (regions: TempoRegion[], doSave = true) => {
    for (const region of regions) {
      if (isTappedTempo(region)) {
        recomputeTempo(region);
        setTimesBetweenBeats(region);
      } else if (isFixedTempo(region)) {
        recomputePhaseOffset(region);
      }
    }
    drawAutopoints(regions);
    if (doSave) {
      saveState();
    }
  };
  const saveState = (): SaveObject => {
    const roundTime = (t: number) => {
      const n = 6;
      return Math.round(t * Math.pow(10, n)) / Math.pow(10, n);
    };
    const j: SaveObject = {
      tempoRegions: regions.map((r) => {
        const inferredBeats: number[] = computeAutoBeats(r);
        return {
          tempo:
            r.tempo.type === "fixed"
              ? { type: "fixed", bpm: r.tempo.bpm }
              : { type: "tapped" },
          offbeatsMarked: r.offbeatsMarked,
          markedBeats: r.userBeats.map((b) => roundTime(b.time)),
          inferredBeats,
        };
      }),
    };
    opts.save(j);
    return j;
  };
  const addPoint = ({
    time,
    isTempoChange,
  }: {
    time: number;
    isTempoChange: boolean;
  }) => {
    if (regions.length === 0) {
      const r: TempoRegion = {
        id: nextRegionId(),
        index: 0,
        startTime: time,
        endTime: duration,
        userBeats: [],
        autoBeats: [],
        tempo: { type: "tapped", value: null },
        offbeatsMarked: false,
      };
      regions.push(r);
      selectedRegionId = regions[0].id;
    }
    const containingRegionIndex = (() => {
      if (time < regions[0].startTime) {
        return 0;
      }
      return regions.findIndex((r) => r.startTime <= time && time < r.endTime);
    })();
    if (containingRegionIndex < 0) {
      return null;
    }
    const containingRegion = regions[containingRegionIndex];
    console.assert(
      isSortedAscending(containingRegion.userBeats, (b) => b.time),
    );
    const firstIdxAfter = containingRegion.userBeats.findIndex(
      (p) => time < p.time,
    );
    const insertAt =
      firstIdxAfter >= 0 ? firstIdxAfter : containingRegion.userBeats.length;
    const pointAfter = (() => {
      if (insertAt < containingRegion.userBeats.length) {
        return containingRegion.userBeats[insertAt];
      } else if (containingRegion.index < regions.length - 1) {
        return regions[containingRegion.index + 1].userBeats[0];
      } else {
        return null;
      }
    })();
    const pointBefore = (() => {
      if (insertAt > 0) {
        return containingRegion.userBeats[insertAt - 1];
      } else if (containingRegion.index > 0) {
        return regions[containingRegion.index - 1].userBeats[0];
      } else {
        return null;
      }
    })();
    if (pointAfter !== null && pointAfter.time - time < MIN_BEAT_SPACING) {
      // too close to point after
      return null;
    }
    let changedRegions: TempoRegion[] = [];
    if (isTempoChange) {
      const createNewRegion = !(containingRegionIndex === 0 && insertAt === 0);

      if (createNewRegion) {
        const newRegionIndex = containingRegion.index + 1;
        const newBeat: UserBeat = {
          id: nextUserBeatId(),
          markerType: "user",
          regionIndex: newRegionIndex,
          isTempoChange: true,
          time,
          localBeatPeriod: null,
        };
        const removedFromContaining = containingRegion.userBeats.splice(
          insertAt,
          containingRegion.userBeats.length - insertAt,
        );
        const newRegionPoints = [newBeat].concat(removedFromContaining);
        const newRegion: TempoRegion = {
          id: nextRegionId(),
          index: newRegionIndex,
          userBeats: newRegionPoints,
          autoBeats: [],
          startTime: time,
          endTime: containingRegion.endTime,
          tempo:
            containingRegion.tempo.type === "fixed"
              ? {
                  type: "fixed",
                  bpm: containingRegion.tempo.bpm,
                  phaseOffset: 0,
                }
              : { type: "tapped", value: null },
          offbeatsMarked: containingRegion.offbeatsMarked,
        };
        containingRegion.endTime = time;
        regions.splice(newRegionIndex, 0, newRegion);
        userBeatsById.set(newBeat.id, regions[newRegionIndex].userBeats[0]);
        reassignRegionIndices();
        changedRegions.push(regions[newRegionIndex], containingRegion);
        selectedRegionId = newRegion.id;
      } else {
        containingRegion.startTime = time;
        const newBeat: UserBeat = {
          markerType: "user",
          id: nextUserBeatId(),
          time,
          regionIndex: containingRegionIndex,
          isTempoChange: true,
          localBeatPeriod: null,
        };
        containingRegion.userBeats.splice(insertAt, 0);
        userBeatsById.set(newBeat.id, containingRegion.userBeats[insertAt]);
        changedRegions.push(containingRegion);
        selectedRegionId = containingRegion.id;
      }
    } else {
      if (pointBefore !== null && time - pointBefore.time < MIN_BEAT_SPACING) {
        return null;
      }
      const newBeat: UserBeat = {
        markerType: "user",
        id: nextUserBeatId(),
        time,
        regionIndex: containingRegionIndex,
        isTempoChange: false,
        localBeatPeriod: 0,
      };
      containingRegion.userBeats.splice(insertAt, 0, newBeat);
      userBeatsById.set(newBeat.id, containingRegion.userBeats[insertAt]);
      containingRegion.startTime = Math.min(
        newBeat.time,
        containingRegion.startTime,
      );
      selectedRegionId = containingRegion.id;
      changedRegions.push(containingRegion);
    }
    onRegionsChanged(changedRegions);
  };

  const deletePoint = (id: number) => {
    const beat = userBeatsById.get(id);
    assertNotNull(beat, "beat by id is null");
    let changedRegions: TempoRegion[] = [];
    const containingRegion = regions[beat.regionIndex];
    if (beat.isTempoChange) {
      console.assert(containingRegion.userBeats[0].id === beat.id);
      if (containingRegion.index > 0) {
        const previousRegion = regions[containingRegion.index - 1];
        previousRegion.userBeats.splice(
          previousRegion.userBeats.length,
          0,
          ...containingRegion.userBeats.slice(
            Math.max(1, containingRegion.userBeats.length - 1),
          ),
        );
        previousRegion.endTime = containingRegion.endTime;
        regions.splice(containingRegion.index, 1);
        reassignRegionIndices();
        changedRegions.push(previousRegion);
        if (selectedRegionId === containingRegion.id) {
          selectedRegionId = previousRegion.id;
        }
      }
    } else {
      const idxInRegion = containingRegion.userBeats.findIndex(
        (b) => b.id === id,
      );
      console.assert(idxInRegion >= 0);
      if (idxInRegion === 0) {
        console.assert(containingRegion.index === 0);
      }
      containingRegion.userBeats.splice(idxInRegion, 1);
      if (containingRegion.userBeats.length > 0) {
        containingRegion.startTime = containingRegion.userBeats[0].time;
        changedRegions.push(containingRegion);
      } else {
        regions.splice(containingRegion.index, 1);
        if (selectedRegionId === containingRegion.id) {
          selectedRegionId = null;
        }
        reassignRegionIndices();
      }
    }
    onRegionsChanged(changedRegions);
  };

  const tryMovePoint = (
    id: number,
    toTime: number,
    what: "start" | "move" | "end",
  ): number => {
    const beat = userBeatsById.get(id);
    assertNotNull(beat, "beat by id is null");
    const containingRegion = regions[beat.regionIndex];
    const prevRegion =
      beat.regionIndex > 0 ? regions[beat.regionIndex - 1] : null;
    console.assert(
      isSortedAscending(containingRegion.userBeats, (b) => b.time),
    );
    const beatIdx = containingRegion.userBeats.findIndex(
      (b) => b.id === beat.id,
    );
    console.assert(beatIdx >= 0);
    let clamped = toTime;
    if (beatIdx > 0) {
      clamped = Math.max(
        clamped,
        containingRegion.userBeats[beatIdx - 1].time + MIN_BEAT_SPACING,
      );
    } else if (prevRegion !== null) {
      if (prevRegion.userBeats.length > 0) {
        clamped = Math.max(
          clamped,
          prevRegion.userBeats[prevRegion.userBeats.length - 1].time +
            MIN_BEAT_SPACING,
        );
      }
    }
    if (beatIdx < containingRegion.userBeats.length - 1) {
      clamped = Math.min(
        clamped,
        containingRegion.userBeats[beatIdx + 1].time - MIN_BEAT_SPACING,
      );
    } else if (containingRegion.index < regions.length - 1) {
      const nextRegion = regions[containingRegion.index + 1];
      clamped = Math.min(
        clamped,
        nextRegion.userBeats[0].time - MIN_BEAT_SPACING,
      );
    }
    if (
      containingRegion.index === regions.length - 1 &&
      beatIdx === containingRegion.userBeats.length - 1
    ) {
      clamped = Math.min(clamped, duration);
    }

    beat.time = clamped;
    if (beatIdx === 0) {
      containingRegion.startTime = clamped;
      if (prevRegion !== null) {
        prevRegion.endTime = clamped;
      }
    }
    if (what === "end") {
      onRegionsChanged([containingRegion]);
    }
    return clamped;
  };

  const setViewport = (v: { startTime: number; endTime: number }) => {
    if (v.startTime === viewport.startTime && v.endTime === viewport.endTime) {
      return;
    }
    viewport = v;
    drawAutopoints([]);
  };

  const computeAutoBeats = (region: TempoRegion): number[] => {
    const beats: number[] = [];
    if (region.tempo.type === "tapped" && region.tempo.value !== null) {
      const period = region.tempo.value.meanPeriod;
      for (const [i, userBeat] of region.userBeats.entries()) {
        const upTo =
          i < region.userBeats.length - 1
            ? region.userBeats[i + 1].time
            : region.endTime;
        for (
          let t = userBeat.time + region.tempo.value.meanPeriod;
          t < upTo;
          t += region.tempo.value.meanPeriod
        ) {
          beats.push(t);
        }
      }
    } else if (region.tempo.type === "fixed") {
      const period = 60 / region.tempo.bpm;
      for (
        let t = region.startTime + region.tempo.phaseOffset;
        t < region.endTime;
        t += period
      ) {
        beats.push(t);
      }
    }
    return beats;
  };

  const drawAutopoints = (changedRegions: TempoRegion[]) => {
    const drawBuffer = 30;
    const drawStart = Math.max(viewport.startTime - drawBuffer, 0);
    const drawEnd = Math.min(viewport.endTime + drawBuffer, duration);
    let regionsInView: TempoRegion[] = [];
    for (const r of regions) {
      if (drawStart <= r.endTime && r.startTime < drawEnd) {
        regionsInView.push(r);
      } else {
        r.autoBeats = [];
      }
    }
    for (const region of regionsInView) {
      const autoBeats = computeAutoBeats(region);
      const recyclePoints = region.autoBeats.length;
      let pointsRecycled = 0;
      let pointsPlaced = 0;
      for (const t of autoBeats) {
        if (t < drawStart || drawEnd <= t) {
          continue;
        }
        if (pointsPlaced < recyclePoints) {
          region.autoBeats[pointsPlaced].time = t;
          pointsRecycled++;
        } else {
          const newPoint: AutoBeat = {
            id: nextAutoBeatId(),
            markerType: "auto",
            time: t,
            regionIndex: region.index,
          };
          region.autoBeats.push(newPoint);
        }
        pointsPlaced++;
      }
      if (pointsRecycled < recyclePoints) {
        region.autoBeats.splice(
          pointsRecycled,
          region.autoBeats.length - pointsRecycled,
        );
      }
      // const redrawAll =
      //   changedRegions.findIndex((r) => r.id === region.id) >= 0;
      // const redrawAll = true;
      // if (region.tempo.type === "fixed") {
      //   const beatPeriod = 60 / region.tempo.bpm;
      //   if (redrawAll) {
      //     for (
      //       let t = region.startTime + region.tempo.phaseOffset;
      //       t < Math.min(region.endTime, drawEnd);
      //       t += beatPeriod
      //     ) {
      //       assertNotNull(t, "time is null");
      //       if (t < drawStart || drawEnd <= t) {
      //         continue;
      //       }
      //       if (pointsPlaced < recyclePoints) {
      //         region.autoBeats[pointsPlaced].time = t;
      //         pointsRecycled++;
      //       } else {
      //         const newPoint: AutoBeat = {
      //           id: nextAutoBeatId(),
      //           markerType: "auto",
      //           time: t,
      //           regionIndex: region.index,
      //         };
      //         region.autoBeats.push(newPoint);
      //       }
      //       pointsPlaced++;
      //     }
      //   }
      // } else if (region.tempo.type === "tapped") {
      //   if (region.tempo.value === null) {
      //     region.autoBeats = [];
      //   } else {
      //     const recyclePoints = region.autoBeats.length;
      //     let pointsRecycled = 0;
      //     let pointsPlaced = 0;
      //     for (const [i, userBeat] of region.userBeats.entries()) {
      //       if (
      //         i < region.userBeats.length - 1 &&
      //         region.userBeats[i + 1].time < drawStart
      //       ) {
      //         continue;
      //       }
      //       // extend up to next beat
      //       const upTo = Math.min(
      //         i < region.userBeats.length - 1
      //           ? region.userBeats[i + 1].time
      //           : region.endTime,
      //         drawEnd,
      //       );
      //       for (
      //         let t = userBeat.time + region.tempo.value.meanPeriod;
      //         t < upTo;
      //         t += region.tempo.value.meanPeriod
      //       ) {
      //         if (t < drawStart) {
      //           continue;
      //         }
      //         if (pointsPlaced < recyclePoints) {
      //           region.autoBeats[pointsPlaced].time = t;
      //           pointsRecycled++;
      //         } else {
      //           const newPoint: AutoBeat = {
      //             id: nextAutoBeatId(),
      //             markerType: "auto",
      //             time: t,
      //             regionIndex: region.index,
      //           };
      //           region.autoBeats.push(newPoint);
      //         }
      //         pointsPlaced += 1;
      //       }
      //     }
      //     if (pointsRecycled < recyclePoints) {
      //       region.autoBeats.splice(
      //         pointsRecycled,
      //         region.autoBeats.length - pointsRecycled,
      //       );
      //     }
      //   }
      // }
    }
  };

  const setRegionType = (regionId: number, type: "fixed" | "tapped") => {
    const region = regions.find((r) => r.id === regionId);
    assertNotNull(region, "region by id is null");
    if (type === "fixed" && isTappedTempo(region)) {
      const bpm = (() => {
        if (region.tempo.value !== null) {
          return Math.round((60 / region.tempo.value.meanPeriod) * 100) / 100;
        }
        return 60;
      })();
      (region as TempoRegion).tempo = { type: "fixed", bpm, phaseOffset: 0 };
      onRegionsChanged([region]);
    } else if (type === "tapped" && isFixedTempo(region)) {
      (region as TempoRegion).tempo = { type: "tapped", value: null };
      onRegionsChanged([region]);
    }
  };

  const setRegionFixedTempo = (regionId: number, bpm: number) => {
    const region = regions.find((r) => r.id === regionId);
    assertNotNull(region, "region by id is null");
    if (isFixedTempo(region)) {
      region.tempo.bpm = bpm;
      onRegionsChanged([region]);
    } else {
      console.error("tried to set fixed tempo on region of wrong type");
    }
  };

  if (isNotNullish(opts.loadSaved)) {
    const saved = opts.loadSaved;
    for (const region of saved.tempoRegions) {
      if (region.markedBeats.length === 0) {
        console.error("save file contains tempo region with 0 beats");
        continue;
      }
    }
    const loadedRegions: TempoRegion[] = [];
    for (const [regionIdx, savedRegion] of saved.tempoRegions.entries()) {
      const tempo: Tempo =
        savedRegion.tempo.type === "fixed"
          ? { type: "fixed", bpm: savedRegion.tempo.bpm, phaseOffset: 0 }
          : { type: "tapped", value: null };
      const startTime = savedRegion.markedBeats[0];
      const endTime =
        regionIdx < saved.tempoRegions.length - 1
          ? saved.tempoRegions[regionIdx + 1].markedBeats[0]
          : duration;
      if (startTime >= endTime) {
        throw new Error(
          "invalid region start/end times: " + startTime + ", " + endTime,
        );
      }
      if (!isSortedAscending(savedRegion.markedBeats, (v) => v)) {
        throw new Error("invalid save file: beats not in ascending order");
      }
      const userBeats: UserBeat[] = savedRegion.markedBeats.map(
        (beat, beatIdx) => {
          return {
            id: nextUserBeatId(),
            time: beat,
            isTempoChange: beatIdx == 0,
            markerType: "user",
            regionIndex: regionIdx,
            localBeatPeriod: null,
          };
        },
      );
      const region: TempoRegion = {
        id: nextRegionId(),
        index: regionIdx,
        startTime,
        endTime,
        userBeats,
        offbeatsMarked: savedRegion.offbeatsMarked,
        tempo,
        autoBeats: [],
      };
      loadedRegions.push(region);
    }
    regions.push(...loadedRegions);
    for (const r of regions) {
      for (const ub of r.userBeats) {
        userBeatsById.set(ub.id, ub);
      }
    }
    reassignRegionIndices();
    onRegionsChanged(regions, false);
  }

  return {
    get regions() {
      return regions;
    },
    regionById: (id: number): TempoRegion => {
      const r = regions.find((r) => r.id === id);
      assertNotNull(r, "region by id is null");
      return r;
    },
    addPoint,
    deletePoint,
    tryMovePoint,
    setViewport,
    setRegionFixedTempo,
    setRegionType,
    save: () => {
      return saveState();
    },
    get selectedRegion() {
      if (selectedRegionId !== null) {
        const r = regions.find((r) => r.id === selectedRegionId);
        assertNotNull(r, "region by id is null");
        return r;
      } else {
        return null;
      }
    },
    get selectedRegionId() {
      return selectedRegionId;
    },
    set selectedRegionId(id) {
      if (id !== null && isNullish(regions.find((r) => r.id === id))) {
        console.error("set selected region to nonexistent id");
      } else {
        selectedRegionId = id;
      }
    },
  };
};
