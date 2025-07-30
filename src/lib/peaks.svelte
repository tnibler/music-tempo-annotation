<script lang="ts">
  import Peaks, { type PeaksInstance, type PeaksOptions } from 'peaks.js';
  import { onDestroy, onMount } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { assertNotNull, isNotNullish } from './util';

  export type TimeRange = {
    startTime: number;
    endTime: number;
  };

  export type PointId = string;
  export type Point = {
    id: PointId;
    time: number;
    draggable: boolean;
    color?: string | undefined;
    label?: string | undefined;
  };
  export type SegmentId = string;
  export type Segment = {
    id: SegmentId;
    startTime: number;
    endTime: number;
    editable: boolean;
    color?: string | undefined;
    label?: string | undefined;
  };

  let {
    audioEl,
    isPlaying,
    isReady = $bindable(),
    playerTime = $bindable(),
    viewRange = $bindable(),
    totalDuration = $bindable(),
    currentSegmentId = $bindable(),
    onPointEnter,
    onZoomViewClick,
    onPointDrag,
    onPointClick
  }: {
    isReady: boolean,
    audioEl: HTMLAudioElement;
    isPlaying: boolean;
    playerTime: number | undefined;
    totalDuration: number | undefined;
    currentSegmentId: string | null | undefined,
    viewRange: TimeRange;
    onZoomViewClick?: (e: MouseEvent, time: number) => void | undefined;
    onPointEnter?: (id: PointId, time: number) => void | undefined;
    onPointDrag?: (id: PointId, time: number, what: 'start' | 'move' | 'end') => void | undefined;
    onPointClick?: (id: PointId, e: MouseEvent, preventViewEvent: () => void) => void | undefined;
  } = $props();
  let zoomviewEl: HTMLElement | undefined = $state();
  let overviewEl: HTMLElement | undefined = $state();
  let overviewWidth: number | undefined = $state();
  let zoomviewWidth: number | undefined = $state();

  let peaks: PeaksInstance | null = $state(null);

  const zoomLevels = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].map((i) => i * 128);

  $effect(() => {
    if (isNotNullish(peaks) && isNotNullish(zoomviewEl) && isNotNullish(overviewEl)) {
      zoomviewWidth;
      overviewWidth;
      peaks.views.getView('zoomview')?.fitToContainer();
      peaks.views.getView('overview')?.fitToContainer();
    }
  });

  export async function setSource(url: string) {
    isReady = false;
    if (peaks !== null) {
      return new Promise<void>((resolve, reject) => {
        peaks?.setSource(
          {
            mediaUrl: url,
            webAudio: { audioContext: new AudioContext() }
          },
          (err) => {
            if (err) {
              reject(err);
            } else {
              isReady = true;
              assertNotNull(peaks, 'peaks is null');
              totalDuration = peaks.player.getDuration();
              resolve();
            }
          }
        );
      });
    }
  }

  export function getCurrentTime(): number | null {
    return peaks?.player?.getCurrentTime() ?? null;
  }

  export function addPoint(point: Point) {
    assertNotNull(peaks, 'peaks is null');
    peaks.points.add({
      id: point.id,
      time: point.time,
      ...(isNotNullish(point.draggable) && { editable: point.draggable }),
      ...(isNotNullish(point.color) && { color: point.color }),
      ...(isNotNullish(point.label) && { label: point.label })
    });
  }

  export function updatePoint(point: { 
    id: PointId, 
    time?: number | undefined,
    draggable?: boolean | undefined,
    color?: string | undefined,
    label?: string | undefined,
  }) {
    assertNotNull(peaks, 'peaks is null');
    const p = peaks.points.getPoint(point.id);
    assertNotNull(p, 'updatePoint: point by id is null');
    p.update({
      ...(isNotNullish(point.time) && { time: point.time }),
      ...(isNotNullish(point.draggable) && { editable: point.draggable }),
      ...(isNotNullish(point.color) && { color: point.color }),
      ...(isNotNullish(point.label) && { labelText: point.label })
    });
  }
  
  export function addSegment(segment: Segment) {
    assertNotNull(peaks, "peaks is null");
    peaks.segments.add({
      id: segment.id,
      startTime: segment.startTime,
      endTime: segment.endTime,
      overlay: true,
      overlayOpacity: 0.7,
      ...(isNotNullish(segment.editable) && { editable: segment.editable }),
      ...(isNotNullish(segment.color) && { color: segment.color }),
      ...(isNotNullish(segment.label) && { labelText: segment.label })
    })
  }

  export function updateSegment(segment: {
    id: SegmentId;
    startTime?: number | undefined,
    endTime?: number | undefined,
    editable?: boolean | undefined,
    color?: string | undefined,
    label?: string | undefined,
  }) {
    assertNotNull(peaks, "peaks is null");
    const s = peaks.segments.getSegment(segment.id);
    assertNotNull(s, 'updateSegment: segment by id is null');
    s.update({
      ...(isNotNullish(segment.startTime) && { startTime: segment.startTime }),
      ...(isNotNullish(segment.endTime) && { endTime: segment.endTime }),
      ...(isNotNullish(segment.editable) && { editable: segment.editable }),
      ...(isNotNullish(segment.color) && { color: segment.color }),
      ...(isNotNullish(segment.label) && { labelText: segment.label })
    });
    
  }

  export function deleteSegment(id: SegmentId) {
    assertNotNull(peaks, 'peaks is null');
    peaks.segments.removeById(id);
  }

  export function deletePoint(id: PointId) {
    assertNotNull(peaks, 'peaks is null');
    peaks.points.removeById(id);
  }

  onMount(() => {
    isReady = false;
    const options: PeaksOptions = {
      keyboard: true,
      zoomview: {
        container: zoomviewEl,
        playheadWidth: 2,
        showPlayheadTime: true
      },
      zoomLevels,
      overview: {
        container: overviewEl,
        showPlayheadTime: true,
        enablePoints: false
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
    Peaks.init(options, (err, instance) => {
      if (err || instance === undefined) {
        console.error('Failed to initialize Peaks instance: ' + err.message);
        return;
      }
      peaks = instance;
      totalDuration = peaks.player.getDuration();

      peaks.on('zoomview.contextmenu', (ev) => {
        ev.evt.preventDefault();
      });
      peaks.on('player.timeupdate', (newTime) => {
        playerTime = newTime;
      });
      peaks.on('player.pause', (t) => {
        isPlaying = false;
      });
      peaks.on('player.playing', (t) => {
        isPlaying = true;
      });
      peaks.on('zoomview.update', (e) => {
        viewRange = { startTime: e.startTime, endTime: e.endTime };
      });
      peaks.on('zoomview.click', (e) => {
        if (onZoomViewClick) {
          onZoomViewClick(e.evt, e.time);
        }
      });
      peaks.on('points.enter', (e) => {
        if (onPointEnter && e.point.id) {
          onPointEnter(e.point.id, e.time);
        }
      });
      peaks.on('points.dragstart', (e) => {
        if (onPointDrag && e.point.id) {
          onPointDrag(e.point.id, e.point.time, 'start');
        }
      });
      peaks.on('points.dragmove', (e) => {
        if (onPointDrag && e.point.id) {
          onPointDrag(e.point.id, e.point.time, 'move');
        }
      });
      peaks.on('points.dragend', (e) => {
        if (onPointDrag && e.point.id) {
          onPointDrag(e.point.id, e.point.time, 'end');
        }
      });
      peaks.on('points.click', (e) => {
        if (onPointClick && e.point.id) {
          onPointClick(e.point.id, e.evt, e.preventViewEvent);
        }
      });
      peaks.on('segments.enter', (e) => {
        currentSegmentId = e.segment.id;
      });
      peaks.on('segments.exit', (e) => {
        currentSegmentId = null;
      });
      const zoomview = peaks.views.getView('zoomview');
      const overview = peaks.views.getView('overview');
      assertNotNull(zoomview, 'zoomview is null');
      assertNotNull(overview, 'overview is null');
      zoomview.setWheelMode('scroll', { captureVerticalScroll: true });
      isReady = true;
    });

    const onScroll = (event: WheelEvent) => {
      if (peaks === null) {
        return;
      }
      assertNotNull(zoomviewEl, 'zoomviewEl is null');
      const ctrlPressed = event.getModifierState('Control');
      if (ctrlPressed) {
        event.preventDefault();
        event.stopImmediatePropagation();

        if (event.deltaY > 0) {
          // zoom in
          const levelIdx = peaks.zoom.getZoom();
          if (levelIdx < zoomLevels.length - 1) {
            peaks.zoom.setZoom(levelIdx + 1);
          }
        } else {
          // zoom out
          const levelIdx = peaks.zoom.getZoom();
          if (levelIdx > 0) {
            peaks.zoom.setZoom(levelIdx - 1);
          }
        }
      }
    };
    assertNotNull(zoomviewEl, 'zoomview element is null');
    assertNotNull(overviewEl, 'overview element is null');
    zoomviewEl.addEventListener('wheel', onScroll);
    overviewEl.addEventListener('wheel', onScroll);
  });

  onDestroy(() => {
    peaks?.destroy();
  });

  $effect(() => {
    if (peaks === null || playerTime === null || playerTime === undefined) {
      return;
    }
    if (peaks.player.getCurrentTime() != playerTime) {
      peaks.player.seek(playerTime);
    }
  });

  $effect(() => {
    if (peaks !== null) {
      if (isPlaying) {
        peaks.player.play();
      } else {
        peaks.player.pause();
      }
    }
  });
</script>

<div id="zoomview-container" bind:this={zoomviewEl} bind:clientWidth={zoomviewWidth}></div>
<div id="overview-container" bind:this={overviewEl} bind:clientWidth={overviewWidth}></div>

<style>
  #zoomview-container,
  #overview-container {
    height: 300px;
    width: 100%;
  }
</style>
