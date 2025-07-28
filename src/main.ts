import Peaks, { type PeaksOptions, type SegmentOptions } from 'peaks.js';
import './pico.min.css'
import './style.css'

type PointKind = "beat" | "tempoChange";

interface EditPoints {
  addPoint: (id: string, opts: { time: number, draggable: boolean, kind: PointKind }) => void;
  removePoint: (id: string) => void;
  updatePoint: (id: string, opts: { time: number }) => void;
  addSegment: (id: string, opts: { startTime: number, endTime: number, editable: boolean, labelText: string, color: string }) => void;
  updateSegment: (id: string, opts: { startTime?: number | undefined, endTime?: number | undefined, editable?: boolean | undefined, labelText?: string | undefined, color?: string | undefined }) => void;
  removeSegment: (id: string) => void;
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
}

type SaveFile = {
  duration: number;
  beats: { t: number; isTempoChange: boolean | undefined; }[];
  regions: never[];
};

class Annotate {
  totalDuration: number;
  editPoints: EditPoints;
  tempoRegions: TempoRegion[];
  pointsById: Map<string, Point>;
  onChange: (self: Annotate) => void;
  currentUserId = 0;
  currentAutoId = 0;
  currentSegmentId = 0;

  constructor(duration: number, points: EditPoints, onChange: (self: Annotate) => void) {
    this.totalDuration = duration;
    this.editPoints = points;
    this.pointsById = new Map();
    this.tempoRegions = [{ userPoints: [], autoPoints: [], segmentId: null }];
    this.onChange = onChange;
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
    if (kind === 'tempoChange') {
      const removedPoints = containingRegion.userPoints.splice(insertAt, containingRegion.userPoints.length - insertAt)
      const newRegion: TempoRegion = { userPoints: [point].concat(removedPoints), autoPoints: [], segmentId: null };
      for (const point of newRegion.userPoints) {
        point.region = newRegion;
      }
      this.tempoRegions.splice(containingRegionIdx + 1, 0, newRegion);
      if (doUpdate) {
        this.updateTempo(containingRegion);
        this.updateTempo(newRegion);
      }
    } else {
      containingRegion = this.tempoRegions[containingRegionIdx];
      containingRegion.userPoints.splice(insertAt, 0, point)
      if (doUpdate) {
        this.updateTempo(containingRegion)
      }
    }


    this.editPoints.addPoint(point.id, { time, kind, draggable: true });
    this.pointsById.set(point.id, point);
    this.onChange(this);
  }

  onRemovePoint(id: string) {
    const point = this.pointsById.get(id);
    assertNotNull(point, 'point by id is null');
    if (point.userPlaced !== true) {
      return;
    }
    const region = point.region;
    const index = region.userPoints.indexOf(point);
    region.userPoints.splice(index, 1);
    this.pointsById.delete(id);
    this.editPoints.removePoint(point.id);
    this.updateTempo(region);
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
    this.editPoints.updatePoint(id, { time: clamped });
  }

  onPointMoved(id: string, toTime: number) {
    const point = this.pointsById.get(id);
    assertNotNull(point, 'point by id is null');
    this.editPoints.updatePoint(id, { time: toTime });
    this.updateTempo(point.region);
    this.onChange(this);
  }

  updateTempo(region: TempoRegion) {
    const regionIdx = this.tempoRegions.indexOf(region);
    if (region.userPoints.length <= 1) {
      for (const ap of region.autoPoints) {
        this.pointsById.delete(ap.id);
        this.editPoints.removePoint(ap.id);
      }
      region.autoPoints = [];
      if (region.segmentId !== null) {
        this.editPoints.removeSegment(region.segmentId);
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
      let sum = 0;
      let count = 0;
      for (const dist of dists) {
        if (dist < minDist * 1.2) {
          sum += dist;
          count += 1;
        }
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

    const stddev = (() => {
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

    let autoPointsPlaced = 0;
    if (regionIdx != this.tempoRegions.length - 1) {
      console.assert(this.tempoRegions[regionIdx + 1].userPoints[0].kind === 'tempoChange');
    }
    const startTime = region.userPoints[0].time;
    const endTime = regionIdx === this.tempoRegions.length - 1 ? this.totalDuration : this.tempoRegions[regionIdx + 1].userPoints[0].time;
    let userPointIdx = 0;
    let t = startTime;
    while (t + period < endTime && autoPointsPlaced < 10) {
      const placeAutoPoint = (() => {
        if (userPointIdx >= region.userPoints.length) {
          if (regionIdx === this.tempoRegions.length - 1) {
            // last region, no user points after this
            return true;
          } else {
            const nextUserPoint = this.tempoRegions[regionIdx + 1].userPoints[0];
            return Math.abs(t - nextUserPoint.time - period) / period > 0.1;
          }
        }
        const nextUserPoint = region.userPoints[userPointIdx];
        return Math.abs(t - nextUserPoint.time - period) / period > 0.1;
      })();
      if (!placeAutoPoint) {
        userPointIdx += 1;
      } else {
        t += period;
        if (autoPointsPlaced < region.autoPoints.length) {
          const reusePoint = region.autoPoints[autoPointsPlaced];
          reusePoint.time = t;
          this.editPoints.updatePoint(reusePoint.id, { time: t });
        } else {
          const newPoint: AutoPoint = { id: this.nextAutoPointId(), region, time: t, kind: 'beat', userPlaced: false };
          region.autoPoints.push(newPoint);
          this.editPoints.addPoint(newPoint.id, { time: t, draggable: false, kind: 'beat' });
          this.pointsById.set(newPoint.id, newPoint);
        }
        autoPointsPlaced += 1;
      }
    }
    if (autoPointsPlaced < region.autoPoints.length) {
      const toRemove = region.autoPoints.splice(autoPointsPlaced, region.autoPoints.length - autoPointsPlaced);
      for (const ap of toRemove) {
        this.pointsById.delete(ap.id);
        this.editPoints.removePoint(ap.id);
      }
    }
    const segmentColors = ["#E11845", "#87E911", "#0057E9", "#FF00BD", "#F2CA19", "#8931EF"];
    const segmentOpts = {
      startTime,
      endTime,
      labelText: (60 / period).toFixed(2) + " BPM (σ=" + stddev.toFixed(3) + ")",
    };
    if (region.segmentId !== null) {
      this.editPoints.updateSegment(region.segmentId, segmentOpts);
    } else {
      region.segmentId = this.nextSegmentId();
      this.editPoints.addSegment(region.segmentId, {
        ...segmentOpts,
        editable: false,
        color: segmentColors[this.currentSegmentId % segmentColors.length]
      });
    }
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

const zoomLevels = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].map((i) => i * 128);
const options: PeaksOptions = {
  keyboard: true,
  zoomview: {
    container: zoomviewEl,
  },
  zoomLevels,
  overview: {
    container: overviewEl,
  },
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

let peaksEvents: { keypress: (e: KeyboardEvent) => void; wheel: (e: WheelEvent) => void; resize: () => void; download: () => void; } | null = null;

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
    const annotate = new Annotate(peaks.player.getDuration(), {
      addPoint: (id, { time, kind, draggable }) => {
        const color = kind === 'beat' ? '#006eb0' : '#ff0000';
        peaks.points.add({ time, id, color, editable: draggable });
      },
      removePoint: (id) => {
        peaks.points.removeById(id);
      },
      updatePoint: (id, { time }) => {
        const point = peaks.points.getPoint(id);
        assertNotNull(point, 'point by id is null');
        point.update({ time });
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
      removeSegment: (id) => {
        peaks.segments.removeById(id);
      },
    }, onChange);
    if (savedJson !== null && savedJson !== undefined) {
      annotate.loadFromSaved(JSON.parse(savedJson));
    }

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
    peaksEvents = {
      keypress: (event: KeyboardEvent) => {
        if (event.key == " ") {
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
      }
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

let currentFile: File | null = null;
if (input.files !== null && input.files.length > 0) {
  loadFile(input.files[0]);
} else {
  initPeaks(window.localStorage['sample']);
}


// TODO: move markers hangs, 
// TODO: remove event listeners on reinit peaks
