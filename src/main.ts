import Peaks, { type PeaksOptions } from 'peaks.js';
import './style.css'

type PointId = string;

type PointKind = "beat" | "tempoChange";

interface EditPoints {
  addPoint: (id: string, opts: { time: number, draggable: boolean, kind: PointKind }) => void;
  removePoint: (id: string) => void;
  updatePoint: (id: string, opts: { time: number }) => void;
}

type TempoRegion = {
  userPoints: (Point & { userPlaced: true })[],
  autoPoints: (Point & { userPlaced: false })[],
}

type Point = {
  id: string,
  time: number,
  kind: PointKind,
  userPlaced: boolean,
  region: TempoRegion,
};

class Annotate {
  totalDuration: number;
  editPoints: EditPoints;
  userPoints: Point[] = [];
  autoPoints: Point[] = [];
  tempoRegions: TempoRegion[];
  pointsById: Map<string, Point>;
  currentUserId = 0;
  currentAutoId = 0;

  constructor(length: number, points: EditPoints) {
    this.totalDuration = length;
    this.editPoints = points;
    this.pointsById = new Map();
    this.tempoRegions = [{ userPoints: [], autoPoints: [] }];
  }

  onAddPoint(time: number, kind: PointKind) {
    console.assert(this.tempoRegions.length > 0);

    const containingRegionIdx = (() => {
      if (this.tempoRegions[0].userPoints.length === 0 && (this.tempoRegions.length === 1 || time < this.tempoRegions[1].userPoints[0].time)) {
        return 0;
      }
      for (const [i, r] of this.tempoRegions.entries()) {
        if (i === 0) { continue; }
        console.assert(r.userPoints.length > 0);
        const startOk = r.userPoints.at(0).time < time;
        const endOk = (i == this.tempoRegions.length - 1) || time < this.tempoRegions[i + 1].userPoints.at(0)!.time;
        if (startOk && endOk) {
          return i;
        }
      }
      return -1;
    })();

    console.assert(containingRegionIdx >= 0);

    let containingRegion: TempoRegion;
    let insertAt = 0;
    while (insertAt < containingRegion.userPoints.length && containingRegion.userPoints[insertAt].time < time) {
      insertAt++;
    }
    if (kind === 'tempoChange') {
      containingRegion.userPoints.splice(insertAt + 1, containingRegion.userPoints.length - insertAt - 1)
    } else {
      containingRegion = this.tempoRegions[containingRegionIdx];
      containingRegion.userPoints.splice(insertAt, 0,)
    }

    const point = { id, time, kind, region, userPlaced: true };

    let region: TempoRegion;
    if (kind == 'tempoChange') {
      const containing = this.tempoRegions[containingRegionIdx];
      region = {
        userPointsStart: insertAt,
        userPointsEnd: containing.userPointsEnd,
        autoPointsStart: 0, autoPointsEnd: 0
      };
      containing.userPointsEnd = insertAt;
      this.tempoRegions.splice(containingRegionIdx + 1, 0, region);
    } else {
      region = this.tempoRegions[containingRegionIdx];
      this.autoPoints.splice(region.au)
    }

    const id = this.nextUserPointId();
    this.userPoints.splice(insertAt, 0, point);
    this.editPoints.addPoint(id, { time, kind, draggable: true });
    this.pointsById.set(id, point);

    // this.updateTempo(insertAt);

    console.assert(this.tempoRegions.length > 0 && this.tempoRegions.length < this.userPoints.length + 1);
    console.assert(this.tempoRegions[0].userPointsStart === 0);
    console.assert(this.tempoRegions[0].autoPointsStart === 0);
    console.assert(this.tempoRegions[this.tempoRegions.length - 1].userPointsEnd === this.userPoints.length);
    console.assert(this.tempoRegions[this.tempoRegions.length - 1].autoPointsEnd === this.autoPoints.length);
    if (this.tempoRegions.length > 0) {
      for (let i = 1; i < this.tempoRegions.length; i++) {
        console.assert(this.tempoRegions[i].userPointsEnd - this.tempoRegions[i].userPointsStart > 0);
        console.assert(this.tempoRegions[i - 1].userPointsEnd == this.tempoRegions[i].userPointsStart);
        console.assert(this.tempoRegions[i - 1].autoPointsEnd == this.tempoRegions[i].autoPointsStart);
      }
    }
  }

  onRemovePoint(id: string) {
    const point = this.pointsById.get(id);
    const index = this.userPoints.indexOf(point);
    this.userPoints.splice(index, 1);
    this.editPoints.removePoint(point.id);
    this.updateTempo(Math.max(Math.min(index, this.userPoints.length - 1), 0));
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
    const idx = this.userPoints.indexOf(point);
    let clamped = toTime;
    console.assert(idx >= 0);
    if (idx > 0) {
      clamped = Math.max(toTime, this.userPoints[idx - 1].time + 0.1);
    }
    if (idx < this.userPoints.length - 1) {
      clamped = Math.min(toTime, this.userPoints[idx + 1].time - 0.1);
    }
    point.time = clamped;
    this.editPoints.updatePoint(id, { time: clamped });
  }

  onPointMoved(id: string, toTime: number) {
    this.editPoints.updatePoint(id, { time: toTime });
    this.updateTempo(id);
  }

  updateTempo(modifiedIndex: number) {
    console.assert(modifiedIndex >= 0);
    console.assert(modifiedIndex < this.userPoints.length);
    let pointRangeStart = modifiedIndex;
    while (pointRangeStart > 0 && this.userPoints[pointRangeStart - 1].kind == 'beat') {
      pointRangeStart -= 1;
    }
    let pointRangeEnd = modifiedIndex;
    while (pointRangeEnd < this.userPoints.length && this.userPoints[pointRangeStart].kind == 'beat') {
      pointRangeEnd += 1;
    }

    const nPoints = pointRangeEnd - pointRangeStart;
    if (nPoints <= 1) {
      return;
    }

    let maxDist = 0;
    let cumSum = 0;
    let firstMeanCount = 0;
    for (let i = pointRangeStart + 1; i < pointRangeEnd; i++) {
      const dist = this.userPoints[i].time - this.userPoints[i - 1].time;
      if (firstMeanCount > 0) {
        const meanSoFar = cumSum / firstMeanCount;
        if (dist > 1.7 * meanSoFar) {
          break;
        }
      }
      cumSum += dist;
      maxDist = Math.max(maxDist, dist);
      firstMeanCount += 1;
    }
    const firstPeriodEstimate = cumSum / firstMeanCount;
    let periodCount = firstMeanCount;
    if (firstMeanCount < nPoints - 1) {
      for (let i = firstMeanCount + 1; i < pointRangeEnd; i++) {
        const dist = this.userPoints[i].time - this.userPoints[i - 1].time;
        const periods = Math.round(dist / firstPeriodEstimate);
        cumSum += dist;
        periodCount += periods;
      }
    }
    const period = cumSum / periodCount;
    console.log(60 / period);
    for (let point of this.autoPoints) {
      this.editPoints.removePoint(point.id)
    }
    this.autoPoints = [];
    let pi = pointRangeStart + firstMeanCount;
    let t = this.userPoints[pi].time;
    let pointsPlaced = 0;
    let endTime = pointRangeEnd == this.userPoints.length ? this.totalDuration : this.userPoints[pointRangeEnd + 1].time;
    if (pointRangeEnd != this.userPoints.length) {
      console.assert(this.userPoints[pointRangeEnd + 1].kind === 'tempoChange');
    }
    while (t + period < endTime && pointsPlaced < 10000) {
      let placeAutoPoint = false;
      if (pi < pointRangeEnd - 1) {
        const interval = this.userPoints[pi + 1].time - t;
        if (interval > 1.5 * period) {
          placeAutoPoint = true;
        } else {
          pi += 1;
          t = this.userPoints[pi].time;
        }
      } else {
        placeAutoPoint = true;
      }
      if (placeAutoPoint) {
        const pointId = `auto` + this.currentAutoId;
        const point: Point = { id: pointId, time: t + period, userPlaced: false };
        this.currentAutoId += 1;
        this.autoPoints.push(point);
        this.editPoints.addPoint(pointId, { time: t + period, kind: 'beat', draggable: false });
        t += period;
        pointsPlaced += 1;
      }
    }
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

const zoomviewEl = document.getElementById('zoomview-container');
if (zoomviewEl === null) {
  throw new Error('zoomviewEl is null');
}

const zoomLevels = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].map((i) => i * 128);
const options: PeaksOptions = {
  keyboard: true,
  zoomview: {
    container: zoomviewEl,
  },
  zoomLevels,
  overview: {
    container: document.getElementById('overview-container')
  },
  mediaElement: document.getElementById('audio'),
  webAudio: {
    audioContext: new AudioContext()
  }
};

Peaks.init(options, function(err, peaks) {
  if (err || peaks === undefined) {
    console.error('Failed to initialize Peaks instance: ' + err.message);
    return;
  }
  const zoomview = peaks.views.getView('zoomview');
  if (!zoomview) {
    console.error("zoomview is null");
    return;
  }

  const annotate = new Annotate(peaks.player.getDuration(), {
    addPoint: (id, { time, kind, draggable }) => {
      const color = kind === 'beat' ? '#006eb0' : '#ff0000';
      peaks.points.add({ time, id, color, editable: draggable });
    },
    removePoint: (id) => {
      peaks.points.removeById(id);
    },
    updatePoint: (id, { time }) => {
      peaks.points.getPoint(id)!.update({ time });
    }
  });

  zoomview.setWheelMode("scroll", { captureVerticalScroll: true });
  zoomview.setWaveformDragMode("scroll");
  peaks.on("zoomview.contextmenu", (ev) => {
    ev.evt.preventDefault();
  });
  peaks.on("zoomview.click", (event) => {
    if (event.evt.button == 2) {
      const kind = event.evt.getModifierState("Control") ? 'tempoChange' : 'beat';
      console.log(kind);
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
  });

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
  document.addEventListener("keypress", function(event) {
    if (event.key == " ") {
      if (isPlaying) {
        peaks.player.pause();
      } else {
        peaks.player.play();
      }
    }
  });
  document.addEventListener("wheel", (event) => {
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
  }, { capture: true, passive: false });

});
