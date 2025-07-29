import Peaks, { type PeaksOptions, type SegmentOptions } from 'peaks.js';
import './pico.min.css'
import './style.css'

type PointKind = "beat" | "tempoChange";

interface Controls {
  addPoint: (id: string, opts: { time: number, draggable: boolean, kind: PointKind }) => void;
  removePoint: (id: string) => void;
  updatePoint: (id: string, opts: { time?: number | undefined, color?: string | undefined }) => void;
  addSegment: (id: string, opts: { startTime: number, endTime: number, editable: boolean, labelText: string, color: string }) => void;
  updateSegment: (id: string, opts: { startTime?: number | undefined, endTime?: number | undefined, editable?: boolean | undefined, labelText?: string | undefined, color?: string | undefined }) => void;
  removeSegment: (id: string) => void;
  displayRegionInfo: (region: TempoRegion) => void;
}


type UserPoint = {
  id: string,
  userPlaced: true,
  time: number,
  kind: PointKind,
  region: TempoRegion,
};

type AutoPoint = {
  id: string,
  userPlaced: false,
  time: number,
  kind: PointKind,
  region: TempoRegion,
};

type Point = UserPoint | AutoPoint;

type TempoRegion = {
  userPoints: UserPoint[],
  autoPoints: AutoPoint[],
  segmentId: string | null,
  beatPeriod: number | null,
  bpmStddev: number | null,
  // markedOffBeat: boolean,
  endTime: number,
  startError: number,
}

type SaveFile = {
  duration: number;
  beats: { t: number; isTempoChange: boolean | undefined; }[];
  regions: never[];
};

class Annotate {
  totalDuration: number;
  controls: Controls;
  tempoRegions: TempoRegion[];
  pointsById: Map<string, Point>;
  onChange: (self: Annotate) => void;
  currentUserId = 0;
  currentAutoId = 0;
  currentSegmentId = 0;
  autoPointsVisibleRange: { start: number, end: number } = { start: 0, end: 0 };
  viewport: { start: number, end: number } = { start: Infinity, end: -Infinity };

  constructor(duration: number, points: Controls, onChange: (self: Annotate) => void) {
    this.totalDuration = duration;
    this.controls = points;
    this.pointsById = new Map();
    this.tempoRegions = [{
      userPoints: [],
      autoPoints: [],
      segmentId: null,
      beatPeriod: null,
      bpmStddev: null,
      endTime: duration,
      startError: 0,
    }];
    this.onChange = onChange;
    this.controls.displayRegionInfo(this.tempoRegions[0]);
  }

  loadFromSaved(saved: SaveFile) {
    for (const beat of saved.beats) {
      this.onAddPoint(beat.t, beat.isTempoChange ? 'tempoChange' : 'beat');
    }
    for (const region of this.tempoRegions) {
      this.updateTempo(region);
    }
  }

  toSaveFile(): SaveFile {
    const beats = this.tempoRegions.flatMap((r) =>
      r.userPoints.map((p) => {
        return {
          t: p.time,
          isTempoChange: p.kind === 'tempoChange' ? true : undefined,
        };
      })
    );
    return {
      duration: this.totalDuration,
      beats: beats,
      regions: [],
    };
  }

  deleteAllPoints() {
    this.pointsById = new Map();
    this.tempoRegions = [{
      userPoints: [],
      autoPoints: [],
      segmentId: null,
      beatPeriod: null,
      bpmStddev: null,
      endTime: this.totalDuration,
      startError: 0,
    }];
    this.controls.displayRegionInfo(this.tempoRegions[0]);
  }

  onAddPoint(time: number, kind: PointKind, doUpdate: boolean = true) {
    console.assert(this.tempoRegions.length > 0);

    const containingRegionIdx = (() => {
      if (this.tempoRegions.length === 1) {
        return 0;
      }
      for (const [i, r] of this.tempoRegions.entries()) {
        console.assert(r.userPoints.length > 0 || i === 0);
        const startOk = i === 0 || r.userPoints[0].time < time;
        const endOk = (i == this.tempoRegions.length - 1) || time < this.tempoRegions[i + 1].userPoints.at(0)!.time;
        if (startOk && endOk) {
          return i;
        }
      }
      return -1;
    })();

    console.assert(containingRegionIdx >= 0);

    let containingRegion: TempoRegion = this.tempoRegions[containingRegionIdx];
    const point: UserPoint = { id: this.nextUserPointId(), time, kind, region: containingRegion, userPlaced: true as const };

    let insertAt = 0;
    while (insertAt < containingRegion.userPoints.length && containingRegion.userPoints[insertAt].time < time) {
      insertAt++;
    }
    const maxBpm = 300;
    const minDist = (60 / maxBpm) / 2;
    if (insertAt > 1) {
      const dist = time - containingRegion.userPoints[insertAt - 1].time;
      if (dist < minDist) {
        return;
      }
    }
    if (insertAt < containingRegion.userPoints.length) {
      const dist = containingRegion.userPoints[insertAt].time - time;
      if (dist < minDist) {
        return;
      }
    }
    let changedRegions: TempoRegion[] = [];
    if (kind === 'tempoChange' && insertAt === 0) {
      console.assert(containingRegionIdx === 0);
      containingRegion.userPoints.splice(0, 0, point);
      point.region = containingRegion;
      changedRegions = [containingRegion];
    } else if (kind === 'tempoChange') {
      const removedPoints = containingRegion.userPoints.splice(insertAt, containingRegion.userPoints.length - insertAt)
      const newRegion: TempoRegion = {
        userPoints: [point].concat(removedPoints),
        autoPoints: [],
        segmentId: null,
        endTime: containingRegion.endTime,
        beatPeriod: null,
        startError: 0,
        bpmStddev: null,
      };
      for (const point of newRegion.userPoints) {
        point.region = newRegion;
      }
      containingRegion.endTime = time;
      this.tempoRegions.splice(containingRegionIdx + 1, 0, newRegion);
      changedRegions = [containingRegion, newRegion];
    } else {
      containingRegion = this.tempoRegions[containingRegionIdx];
      containingRegion.userPoints.splice(insertAt, 0, point)
      changedRegions = [containingRegion];
    }

    this.controls.addPoint(point.id, { time, kind, draggable: true });
    this.pointsById.set(point.id, point);
    if (doUpdate) {
      for (const r of changedRegions) {
        this.updateTempo(r);
        this.drawAutoPointsInView(this.viewport.start, this.viewport.end, changedRegions);
      }
      this.controls.displayRegionInfo(point.region);
      this.onChange(this);
    }
  }

  onRemovePoint(id: string) {
    const point = this.pointsById.get(id);
    assertNotNull(point, 'point by id is null');
    if (point.userPlaced !== true) {
      return;
    }
    const region = point.region;
    const regionIdx = this.tempoRegions.indexOf(region);
    const index = region.userPoints.indexOf(point);
    if (regionIdx > 0 && point.kind === 'tempoChange') {
      console.assert(index === 0);
      const previousRegion = this.tempoRegions[regionIdx - 1];
      previousRegion.userPoints = previousRegion.userPoints.concat(region.userPoints.slice(1));
      previousRegion.autoPoints = previousRegion.autoPoints.concat(region.autoPoints);
      previousRegion.endTime = region.endTime;
      if (region.segmentId !== null) {
        this.controls.removeSegment(region.segmentId);
      }
      this.tempoRegions.splice(regionIdx, 1);
      this.updateTempo(previousRegion);
      this.controls.displayRegionInfo(previousRegion);
      this.controls.removePoint(point.id);
      this.drawAutoPointsInView(this.viewport.start, this.viewport.end, [previousRegion]);
    } else {
      region.userPoints.splice(index, 1);
      this.pointsById.delete(id);
      this.controls.removePoint(point.id);
      this.updateTempo(region);
      this.controls.displayRegionInfo(region);
      this.drawAutoPointsInView(this.viewport.start, this.viewport.end, [region]);
    }
    this.onChange(this);
  }

  onPointMoving(id: string, toTime: number) {
    const point = this.pointsById.get(id);
    if (point === undefined) {
      console.error("unknownd point");
      return;
    }
    if (point.userPlaced !== true) {
      console.error("tried to move auto point");
      return;
    }
    const regionPoints = point.region.userPoints;
    const regionIdx = this.tempoRegions.indexOf(point.region);
    const idx = regionPoints.indexOf(point);
    let clamped = toTime;
    console.assert(idx >= 0);
    if (idx > 0) {
      clamped = Math.max(toTime, regionPoints[idx - 1].time + 0.1);
    }
    if (idx < regionPoints.length - 1) {
      clamped = Math.min(clamped, regionPoints[idx + 1].time - 0.1);
    } else if (regionIdx < this.tempoRegions.length - 1) {
      clamped = Math.min(clamped, this.tempoRegions[regionIdx + 1].userPoints[0].time);
    } else {
      clamped = Math.min(clamped, this.totalDuration - 0.1);
    }
    point.time = clamped;
    this.controls.updatePoint(id, { time: clamped });
  }

  onPointMoved(id: string, toTime: number) {
    const point = this.pointsById.get(id);
    assertNotNull(point, 'point by id is null');
    this.controls.updatePoint(id, { time: toTime });
    this.updateTempo(point.region);
    this.controls.displayRegionInfo(point.region);
    this.drawAutoPointsInView(this.viewport.start, this.viewport.end, [point.region]);
    this.onChange(this);
  }

  updateTempo(region: TempoRegion) {
    const regionIdx = this.tempoRegions.indexOf(region);
    if (region.userPoints.length <= 1) {
      region.beatPeriod = null;
      for (const ap of region.autoPoints) {
        this.pointsById.delete(ap.id);
        this.controls.removePoint(ap.id);
      }
      region.autoPoints = [];
      if (region.segmentId !== null) {
        this.controls.removeSegment(region.segmentId);
        region.segmentId = null;
      }
      return;
    }
    let dists = [];
    // assuming minDist is one period/beat
    let minDist = Number.POSITIVE_INFINITY;
    for (let i = 1; i < region.userPoints.length; i++) {
      const dist = region.userPoints[i].time - region.userPoints[i - 1].time;
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

    const period = (() => {
      let sum = 0;
      let count = 0;
      for (const dist of dists) {
        let periods = Math.round(dist / initialEstimate);
        sum += dist;
        count += periods;
      }
      return sum / count;
    })();

    let sumErr = 0;
    let count = 0;
    for (let i = 1; i < region.userPoints.length; i++) {
      const dist = (region.userPoints[i].time - region.userPoints[0].time)
      let periods = Math.round(dist / period);
      sumErr += (periods * period - dist);
      count += 1;
    }
    const meanErr = sumErr / count;
    // console.log(meanErr);


    const bpmStddev = (() => {
      let sumSqDiff = 0;
      let meanTempo = 60 / period;
      let count = 0;
      for (const dist of dists) {
        let nPeriods = Math.round(dist / initialEstimate);
        count += nPeriods;
        let tempo = 60 / (dist / nPeriods);
        sumSqDiff += Math.pow(meanTempo - tempo, 2);
      }
      return Math.sqrt(sumSqDiff / count);
    })();
    region.beatPeriod = period;
    region.bpmStddev = bpmStddev;
    region.startError = meanErr;

    const startTime = region.userPoints[0].time;
    const endTime = regionIdx === this.tempoRegions.length - 1 ? this.totalDuration : this.tempoRegions[regionIdx + 1].userPoints[0].time;
    const segmentColors = ["#E11845", "#87E911", "#0057E9", "#FF00BD", "#F2CA19", "#8931EF"];
    const segmentOpts = {
      startTime,
      endTime,
      labelText: (60 / period).toFixed(2) + " BPM (σ=" + bpmStddev.toFixed(3) + ")",
    };
    if (region.segmentId !== null) {
      this.controls.updateSegment(region.segmentId, segmentOpts);
    } else {
      region.segmentId = this.nextSegmentId();
      this.controls.addSegment(region.segmentId, {
        ...segmentOpts,
        editable: false,
        color: segmentColors[this.currentSegmentId % segmentColors.length]
      });
    }
  }

  viewportChanged(startTime: number, endTime: number) {
    this.viewport = { start: startTime, end: endTime };
    this.drawAutoPointsInView(startTime, endTime);
  }

  onSegmentEntered(segmentId: string) {
    const region = this.tempoRegions.find((r) => r.segmentId === segmentId);
    if (region === undefined) {
      console.error("entered segment that doesn't belong to any region");
      return;
    }
    this.controls.displayRegionInfo(region);
  }

  drawAutoPointsInView(viewStart: number, viewEnd: number, changedRegions: TempoRegion[] = []) {
    const minBuffer = 60;
    if (changedRegions.length === 0 && this.autoPointsVisibleRange.start < viewStart - minBuffer && viewEnd + minBuffer < this.autoPointsVisibleRange.end) {
      // nothing to do
      return;
    }
    if (this.tempoRegions.length === 1 && this.tempoRegions[0].userPoints.length === 0) {
      return;
    }
    const drawBuffer = 180;
    const drawStart = Math.max(viewStart - drawBuffer, 0);
    const drawEnd = Math.min(viewEnd + drawBuffer, this.totalDuration);
    const regionsInView = this.tempoRegions.filter((r, i) => {
      if (r.userPoints.length <= 1) {
        return false;
      }
      const regStart = r.userPoints[0].time;
      const regEnd = (i < this.tempoRegions.length - 1) ? this.tempoRegions[i + 1].userPoints[0].time : this.totalDuration;
      return drawStart <= regEnd && regStart < drawEnd;
    });
    for (const region of regionsInView) {
      console.assert(isSortedAscending(region.autoPoints, (p) => p.time));
      console.assert(isSortedAscending(region.userPoints, (p) => p.time));
      if (region.beatPeriod === null) {
        continue;
      }

      const mergeDistance = Math.max(0.1 * region.beatPeriod, 0.1);
      console.assert(mergeDistance > 0);

      const regionIndex = this.tempoRegions.indexOf(region);
      const regionEnd = (regionIndex < this.tempoRegions.length - 1) ? this.tempoRegions[regionIndex + 1].userPoints[0].time : this.totalDuration;
      if (region.userPoints.length === 0) {
        for (const ap of region.autoPoints) {
          this.pointsById.delete(ap.id);
          this.controls.removePoint(ap.id);
        }
        region.autoPoints = [];
      } else if (changedRegions.indexOf(region) >= 0) {
        // recompute all points
        assertNotNull(region.beatPeriod, "region");
        if (60 / region.beatPeriod > 350) {
          return;
        }

        const startTime = region.userPoints[0].time - region.startError;
        const firstBeatToDraw = startTime + ((startTime >= drawStart) ? 0 : (region.beatPeriod * Math.ceil((drawStart - startTime) / region.beatPeriod)));

        // keep track of the closest user placed point, if it's very close don't place an auto point
        let closestUserPoint = 0

        let pointsPlaced = 0;
        for (let t = firstBeatToDraw; t < Math.min(regionEnd, drawEnd); t += region.beatPeriod) {
          let placeAutoPoint = true;

          if (closestUserPoint <= region.userPoints.length) {
            let dist;
            do {
              if (closestUserPoint < region.userPoints.length) {
                dist = region.userPoints[closestUserPoint].time - t;
              } else if (regionIndex < this.tempoRegions.length - 1) {
                console.assert(this.tempoRegions[regionIndex + 1].userPoints.length > 0);
                dist = region.userPoints[0].time - t;
              } else {
                dist = Infinity;
              }
              if (dist < -mergeDistance) {
                closestUserPoint += 1;
              } else if (dist < mergeDistance) {
                placeAutoPoint = false;
                break;
              } else {
                break;
              }
            } while (dist < -mergeDistance && closestUserPoint <= region.userPoints.length)
          }
          if (placeAutoPoint) {
            if (pointsPlaced < region.autoPoints.length) {
              const reusePoint = region.autoPoints[pointsPlaced];
              reusePoint.time = t;
              this.controls.updatePoint(reusePoint.id, { time: t });
            } else {
              const newPoint: AutoPoint = { id: this.nextAutoPointId(), region, time: t, kind: 'beat', userPlaced: false };
              region.autoPoints.push(newPoint);
              this.controls.addPoint(newPoint.id, { time: t, draggable: false, kind: 'beat' });
              this.pointsById.set(newPoint.id, newPoint);
            }
            pointsPlaced += 1;
          }
        }
        if (pointsPlaced < region.autoPoints.length) {
          const toRemove = region.autoPoints.splice(pointsPlaced, region.autoPoints.length - pointsPlaced);
          for (const ap of toRemove) {
            this.pointsById.delete(ap.id);
            this.controls.removePoint(ap.id);
          }
        }
      } else {
        assertNotNull(region.beatPeriod, "region.beatPeriod is null even though it has >1 points");
        // remove autopoints not in viewrange
        let lastInvisibleIndex = region.autoPoints.findLastIndex((p) => p.time < drawStart);
        let firstInvisibleIndex = region.autoPoints.findIndex((p) => p.time > drawEnd);
        let recyclePoints: AutoPoint[] = [];
        let recycleIndex = 0;
        if (lastInvisibleIndex >= 0) {
          recyclePoints = region.autoPoints.splice(0, lastInvisibleIndex + 1);
        }
        if (firstInvisibleIndex >= 0) {
          const offset = lastInvisibleIndex + 1; // removed this many from the front. works out bc findLastIndex returns -1 if there weren't any 
          const removeBack = region.autoPoints.splice(firstInvisibleIndex + offset, region.autoPoints.length - (firstInvisibleIndex - offset));
          recyclePoints = recyclePoints.concat(removeBack);
        }
        let pointsPlaced = 0;

        const startTime = region.userPoints[0].time;
        const firstBeatToDraw = startTime + ((startTime >= drawStart) ? 0 : (region.beatPeriod * Math.ceil((drawStart - startTime) / region.beatPeriod)));

        let closestUserPoint = 0;
        let prependPoints = [];
        let appendPoints = [];
        for (let t = firstBeatToDraw; t < Math.min(drawEnd, regionEnd); t += region.beatPeriod) {
          let placeAutoPoint = true;
          if (closestUserPoint <= region.userPoints.length) {
            let dist;
            do {
              if (closestUserPoint < region.userPoints.length) {
                dist = region.userPoints[closestUserPoint].time - t;
              } else if (regionIndex < this.tempoRegions.length - 1) {
                dist = region.userPoints[0].time - t;
              } else {
                dist = Infinity;
              }
              if (dist < -mergeDistance) {
                closestUserPoint += 1;
              } else if (dist < mergeDistance) {
                placeAutoPoint = false;
                break;
              } else {
                break;
              }
            } while (dist < -mergeDistance && closestUserPoint <= region.userPoints.length)
          }
          if (!placeAutoPoint || region.autoPoints.length > 0 && region.autoPoints[0].time <= t && t <= region.autoPoints[region.autoPoints.length - 1].time) {
            continue;
          }
          if (region.autoPoints.length === 0 || t < region.autoPoints[0].time) {
            // prepend
            if (recycleIndex < recyclePoints.length) {
              const reusePoint = recyclePoints[recycleIndex];
              recycleIndex += 1;
              reusePoint.time = t;
              this.controls.updatePoint(reusePoint.id, { time: t });
              prependPoints.push(reusePoint);
            } else {
              const newPoint: AutoPoint = { id: this.nextAutoPointId(), region, time: t, kind: 'beat', userPlaced: false };
              this.controls.addPoint(newPoint.id, { time: t, draggable: false, kind: 'beat' });
              this.pointsById.set(newPoint.id, newPoint);
              prependPoints.push(newPoint);
            }
            pointsPlaced += 1;
          } else {
            // append
            if (recycleIndex < recyclePoints.length) {
              const reusePoint = recyclePoints[recycleIndex];
              recycleIndex += 1;
              reusePoint.time = t;
              this.controls.updatePoint(reusePoint.id, { time: t });
              appendPoints.push(reusePoint);
            } else {
              const newPoint: AutoPoint = { id: this.nextAutoPointId(), region, time: t, kind: 'beat', userPlaced: false };
              this.controls.addPoint(newPoint.id, { time: t, draggable: false, kind: 'beat' });
              this.pointsById.set(newPoint.id, newPoint);
              appendPoints.push(newPoint);
            }
          }
        }

        if (recycleIndex < recyclePoints.length) {
          for (let i = recycleIndex; i < recyclePoints.length; i++) {
            this.pointsById.delete(recyclePoints[i].id);
            this.controls.removePoint(recyclePoints[i].id);
          }
        }
        region.autoPoints = prependPoints.concat(region.autoPoints, appendPoints);
      }
    }

    this.autoPointsVisibleRange = { start: drawStart, end: drawEnd };
  }

  nextSegmentId(): string {
    const id = "segment" + this.currentSegmentId;
    this.currentSegmentId += 1;
    return id;
  }

  nextUserPointId(): string {
    const id = "user" + this.currentUserId;
    this.currentUserId += 1;
    return id;
  }

  nextAutoPointId(): string {
    const id = "auto" + this.currentAutoId;
    this.currentAutoId += 1;
    return id;
  }
}

function isSortedAscending<T>(arr: T[], key: (t: T) => number): boolean {
  if (arr.length === 0) {
    return true;
  }
  let prev = key(arr[0]);
  for (let i = 1; i < arr.length; i += 1) {
    const t = key(arr[i]);
    if (prev > t) {
      return false;
    }
    prev = t;
  }
  return true;
}

function assertNotNull<T>(value: T, message: string): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw Error(message);
  }
}

const zoomviewEl = document.getElementById('zoomview-container');
assertNotNull(zoomviewEl, "zoomviewEl is null");
const overviewEl = document.getElementById('overview-container');
assertNotNull(overviewEl, "overviewEl is null");
const audioEl = document.getElementsByTagName("audio").namedItem("audio");
assertNotNull(audioEl, "audioEl is null");
audioEl.addEventListener("error", (e) => {
  console.error(e);
});
const tapButton = document.getElementById("button-metronome");
assertNotNull(tapButton, "button-metronome is null");

const zoomLevels = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].map((i) => i * 128);
const options: PeaksOptions = {
  keyboard: true,
  zoomview: {
    container: zoomviewEl,
    playheadWidth: 2,
    showPlayheadTime: true,
  },
  zoomLevels,
  overview: {
    container: overviewEl,
    showPlayheadTime: true,
    enablePoints: false,
  },
  emitCueEvents: true,
  segmentOptions: {
    markers: false,
    overlay: true,
    overlayOpacity: 0.1,
    overlayBorderWidth: 2,
    overlayCornerRadius: 5,
    overlayOffset: 40,
    overlayLabelAlign: 'left',
    overlayLabelVerticalAlign: 'top',
    overlayLabelPadding: 8,
    overlayLabelColor: '#000000',
    overlayFontFamily: 'sans-serif',
    overlayFontSize: 14,
    overlayFontStyle: 'normal'
  },
  mediaElement: audioEl,
  webAudio: {
    audioContext: new AudioContext()
  }
};

let peaksEvents: {
  keypress: (e: KeyboardEvent) => void;
  wheel: (e: WheelEvent) => void;
  resize: () => void;
  download: () => void;
  tap: () => void;
  playPause: () => void;
  clearAllPoints: () => void;
} | null = null;

function initPeaks(savedJson: string | undefined) {
  Peaks.init(options, function(err, peaks) {
    if (err || peaks === undefined) {
      console.error('Failed to initialize Peaks instance: ' + err.message);
      return;
    }
    const zoomview = peaks.views.getView('zoomview');
    const overview = peaks.views.getView('overview');
    if (!zoomview) {
      console.error("zoomview is null");
      return;
    }
    if (!overview) {
      console.error("overview is null");
      return;
    }

    const onChange = (ann: Annotate) => {
      const filename = currentFile?.name ?? 'sample';
      const save = {
        ...ann.toSaveFile(),
        fileName: filename,
        fileSize: currentFile?.size ?? 0,
      };
      window.localStorage[filename] = JSON.stringify(save);
    };
    const regionOverviewEl = document.getElementById("region-overview");
    assertNotNull(regionOverviewEl, "regionOverviewEl is null");
    const annotate = new Annotate(peaks.player.getDuration(), {
      addPoint: (id, { time, kind, draggable }) => {
        const color = kind === 'beat' ? '#006eb0' : '#ff0000';
        peaks.points.add({ time, id, color, editable: draggable });
      },
      removePoint: (id) => {
        peaks.points.removeById(id);
      },
      updatePoint: (id, opts) => {
        const point = peaks.points.getPoint(id);
        assertNotNull(point, 'point by id is null');
        point.update(opts);
      },
      addSegment: (id, opts) => {
        peaks.segments.add({
          id,
          overlay: true,
          ...opts,
        });
      },
      updateSegment: (id, opts) => {
        const segment = peaks.segments.getSegment(id);
        assertNotNull(segment, 'segment by id is null');
        segment.update(opts as SegmentOptions);
        if (opts.labelText !== undefined) {
          // https://github.com/bbc/peaks.js/issues/563
          for (const view of [zoomview, overview]) {
            const shapes = (view as any)._segmentsLayer._segmentShapes;
            for (const k of Object.keys(shapes)) {
              if ('_segment' in shapes[k] && shapes[k]._segment === segment) {
                shapes[k]!._label.setAttr("text", opts.labelText);
                break;
              }
            }
          }
        }
      },
      displayRegionInfo: (region) => {
        showRegionOverview(region, regionOverviewEl);
      },
      removeSegment: (id) => {
        peaks.segments.removeById(id);
      },
    }, onChange);
    if (savedJson !== null && savedJson !== undefined) {
      annotate.loadFromSaved(JSON.parse(savedJson));
    }

    let tik = true;
    assertNotNull(tapButton, "button-metronome is null");
    tapButton.classList = tik ? "secondary" : "secondary outline";
    peaks.on("points.enter", (e) => {
      tik = !tik;
      tapButton.classList = tik ? "secondary" : "secondary outline";
    });
    zoomview.setWheelMode("scroll", { captureVerticalScroll: true });
    zoomview.setWaveformDragMode("scroll");
    peaks.on("zoomview.contextmenu", (ev) => {
      ev.evt.preventDefault();
    });
    peaks.on("zoomview.click", (event) => {
      if (event.evt.button == 2) {
        const kind = event.evt.getModifierState("Control") ? 'tempoChange' : 'beat';
        annotate.onAddPoint(event.time, kind);
      }
    });
    peaks.on("points.dragmove", (event) => {
      if (event.point.id === undefined) {
        return;
      }
      annotate.onPointMoving(event.point.id, event.point.time);
    });
    peaks.on("points.dragend", (event) => {
      if (event.point.id === undefined) {
        return;
      }
      annotate.onPointMoved(event.point.id, event.point.time);
    })

    peaks.on("points.click", (event) => {
      event.preventViewEvent();
      if (event.evt.button == 2 && event.point.id !== undefined) {
        annotate.onRemovePoint(event.point.id);
      }
    })

    var isPlaying = false;
    peaks.on("player.playing", (e) => {
      isPlaying = true;
    });
    peaks.on("player.pause", (e) => {
      isPlaying = false;
    });
    peaks.on("zoomview.update", (e) => {
      annotate.viewportChanged(e.startTime, e.endTime);
    });
    peaks.on("segments.enter", (e) => {
      if (e.segment.id !== undefined) {
        annotate.onSegmentEntered(e.segment.id);
      }
    });
    peaksEvents = {
      tap: () => {
        annotate.onAddPoint(peaks.player.getCurrentTime(), 'beat');
      },
      playPause: () => {
        if (isPlaying) {
          peaks.player.pause();
        } else {
          peaks.player.play();
        }
      },
      keypress: (event: KeyboardEvent) => {
        if (event.key == " ") {
          event.preventDefault();
          event.stopPropagation();
          if (isPlaying) {
            peaks.player.pause();
          } else {
            peaks.player.play();
          }
        }
      },
      wheel: (event: WheelEvent) => {
        assertNotNull(zoomviewEl, "zoomviewEl is null");
        const overZoomview = event.composedPath().indexOf(zoomviewEl) >= 0;
        const ctrlPressed = event.getModifierState("Control");
        if (overZoomview && ctrlPressed) {
          event.preventDefault();
          event.stopImmediatePropagation();

          if (event.deltaY > 0) {
            // zoom in
            const levelIdx = peaks.zoom.getZoom();
            if (levelIdx < zoomLevels.length - 1) {
              // const span = zoomview.pixelsToTime(zoomviewEl.clientWidth);
              // const fromLevel = zoomLevels[levelIdx];
              // const toLevel = zoomLevels[levelIdx + 1];
              peaks.zoom.setZoom(levelIdx + 1);
            }
          } else {
            // zoom out
            const levelIdx = peaks.zoom.getZoom();
            if (levelIdx > 0) {
              // const toLevel = zoomLevels[levelIdx - 1];
              peaks.zoom.setZoom(levelIdx - 1);
            }
          }
        }
      },
      resize: () => {
        overview.fitToContainer();
        zoomview.fitToContainer();
      },
      download: () => {
        var a = window.document.createElement('a');
        const json = JSON.stringify(annotate.toSaveFile());
        a.href = window.URL.createObjectURL(new Blob([json], { type: 'text/json' }));
        a.download = (currentFile?.name ?? 'sample') + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      },
      clearAllPoints: () => {
        annotate.deleteAllPoints();
        peaks.points.removeAll();
        peaks.segments.removeAll();
      },
    };
  });
}


document.addEventListener("keypress", function(e) {
  if (peaksEvents !== null) {
    peaksEvents.keypress(e);
  }
});

document.addEventListener("wheel", (event) => {
  if (peaksEvents !== null) {
    peaksEvents.wheel(event);
  }
}, { capture: true, passive: false });

let debounceTimer: number | undefined = undefined;
const resizeObserver = new ResizeObserver((entries) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (peaksEvents !== null) {
      peaksEvents.resize();
    }
    debounceTimer = undefined;
  }, 50);
});
resizeObserver.observe(zoomviewEl);
resizeObserver.observe(overviewEl);

function loadFile(file: File) {
  assertNotNull(audioEl, "audioEl is null");
  const url = URL.createObjectURL(file);
  currentFile = file;
  audioEl.src = url;
  const saved = window.localStorage[file.name];
  initPeaks(saved);
}

const input: HTMLInputElement = document.getElementById("file-input") as HTMLInputElement;
input.addEventListener("keyup", (e) => {
  e.preventDefault();
})
input.addEventListener("change", (e) => {
  if (input.files !== null && input.files.length > 0) {
    const file = input.files[0];
    loadFile(file);
  }
});

document.getElementById('button-download')?.addEventListener("click", (e) => {
  if (peaksEvents !== null) {
    peaksEvents.download();
  }
});
document.getElementById('button-play')?.addEventListener("click", (e) => {
  if (peaksEvents !== null) {
    peaksEvents.playPause();
  }
});

const buttonDelete = document.getElementById("button-delete-all");
assertNotNull(buttonDelete, "buttonDelete is null");
let confirmingClear = false;
const deleteText = buttonDelete.innerHTML;
buttonDelete.addEventListener("click", (e) => {
  if (confirmingClear) {
    buttonDelete.innerHTML = deleteText;
    buttonDelete.classList.remove("confirm");
    buttonDelete.classList.add("outline");
    confirmingClear = false;
    if (peaksEvents !== null) {
      peaksEvents.clearAllPoints();
    }
  } else {
    buttonDelete.innerHTML = "Confirm to clear all points";
    confirmingClear = true;
    buttonDelete.classList.add("confirm");
    buttonDelete.classList.remove("outline");
    setTimeout(() => {
      confirmingClear = false;
      buttonDelete.innerHTML = deleteText;
      buttonDelete.classList.remove("confirm");
      buttonDelete.classList.add("outline");
    }, 5000);
  }
});

tapButton.addEventListener("click", (e) => {
  if (peaksEvents !== null) {
    peaksEvents.tap();
  }
})

let currentFile: File | null = null;
if (input.files !== null && input.files.length > 0) {
  loadFile(input.files[0]);
} else {
  initPeaks(window.localStorage['sample']);
}

function showRegionOverview(region: TempoRegion, divEl: HTMLElement) {
  const startTime = region.userPoints.length > 0 ? region.userPoints[0].time : 0;
  const startStr = new Date(1000 * startTime).toISOString().substring(11, 19)
  const endStr = new Date(1000 * region.endTime).toISOString().substring(11, 19)
  const bpm = region.beatPeriod ? (60 / region.beatPeriod).toFixed(3) : "-";
  const stddev = region.bpmStddev?.toFixed(3) ?? "-";
  const html = `
            <h2>Tempo region:</h2>
            <div  id="region-overview">
              <ul>
                <li>${startStr}-${endStr}</li>
                <li>${bpm} bpm (stddev ${stddev})</li>
                <li>${region.userPoints.length} marked beats</li>
              </ul>
            </div>
`;
  divEl.innerHTML = html;
}
