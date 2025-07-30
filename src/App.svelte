<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import Peaks, { type Point, type PointId, type TimeRange } from './lib/peaks.svelte';
  import { Annotate, type IAnnotate, MAX_TEMPO, type SaveObject } from './lib/annotate.svelte';
    import { isNotNullish } from './lib/util';
    import typia from 'typia';
    import { setPointerCapture } from 'konva/lib/PointerEvents';

  let audioEl: HTMLAudioElement = $state() as HTMLAudioElement;
  let peaks: Peaks;
  let peaksReady = $state() as boolean;
  let isPlaying = $state(false);
  let totalDuration = $state() as number;
  let playerTime: number = $state(0);
  let viewRange: TimeRange = $state() as TimeRange;
  let annotate: IAnnotate | null = $state(null) as IAnnotate | null;
  let fixedBpmValue = $state(null) as number | null;
  let openFile = { name: 'sample', size: 0 };
  let inputFileList: FileList | undefined = $state();

  const displayedBeats = new SvelteSet<string>();
  const displayedRegionSegments = new SvelteSet<string>();
  const currentRegion = $derived(annotate?.selectedRegion);

  let metronomeTik = $state(false);

  $effect(() => {
    if (annotate === null || currentRegion === null || currentRegion?.tempo.type !== 'fixed') {
      fixedBpmValue = null;
    }  
  });

  window.addEventListener('keypress', (e) => {
    if (e.key ===' ') {
      e.preventDefault();
      e.stopPropagation();
      isPlaying = !isPlaying;
    }
  });

  $effect(() => {
    if (isNotNullish(inputFileList) && inputFileList.length > 0) {
      const f = inputFileList[0];
      if (f.name !== openFile.name) {
        loadFile(f);
      }
    }
  });

  async function loadFile(file: File) {
    const url = URL.createObjectURL(file);
    await peaks.setSource(url);
    openFile = { name: file.name, size: file.size }
    annotate = null;
  }

  type SaveWithMetadata = {
    fileName: string,
    fileSize: number,
    duration: number,
  } & SaveObject;

  function onDownloadClicked() {
    if (annotate === null) {
      return;
    }
    const fileName = openFile.name;
    const fileSize = openFile.size;
    const save = annotate.save();
    const so: SaveWithMetadata = { fileName, fileSize, duration: totalDuration, ...save};
    var a = window.document.createElement('a');
    const json = JSON.stringify(so);
    a.href = window.URL.createObjectURL(new Blob([json], { type: 'text/json' }));
    a.download = (openFile.name) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

  }

  $effect(() => {
    if (annotate === null && peaksReady && isNotNullish(totalDuration)) {
      let saved = null;
      const fileName = openFile.name;
      const fileSize = openFile.size;
      if (fileName in window.localStorage) {
        const json = window.localStorage[fileName];
        saved = JSON.parse(json);
        if (!typia.is<SaveWithMetadata>(saved)) {
          throw new Error('invalid save file for key: ' + fileName);
        }
      }
      if (saved !== null && totalDuration !== saved.duration) {
        throw new Error('mismatching durations between save file and opened audio');
      }
      annotate = Annotate({
        duration: totalDuration,
        save: (s: SaveObject) => {
          const so: SaveWithMetadata = { fileName, fileSize, duration: totalDuration, ...s};
          window.localStorage[fileName] = JSON.stringify(so);
        },
        loadSaved: saved,
      });
    }
  });

  $effect(() => {
    if (annotate !== null && isNotNullish(viewRange)) {
      annotate.setViewport(viewRange);
    }
  });

  function onCurrentSegmentChanged(strId: string) {
    if (annotate !== null) {
      annotate.selectedRegionId = strId !== null ? stringToRegionId(strId) : null;
    }
  }

  function getCurrentSegment(): string | null {
    if (annotate === null || annotate.selectedRegionId === null) {
      return null;
    }
    return regionIdToString(annotate.selectedRegionId);
  }

  $effect(() => {
    let stillExistingIds = new Set();
    if (annotate !== null) {
      for (const region of annotate.regions) {
        for (const beat of region.userBeats) {
          const label = (region.tempo.type === 'tapped' && beat.localBeatPeriod !== null) ? `${(60 / beat.localBeatPeriod).toFixed(2)} bpm` : '';
          const id = userBeatIdToString(beat.id);
          stillExistingIds.add(id);
          if (!displayedBeats.has(id)) {
            displayedBeats.add(id);
            peaks.addPoint({ 
              id, 
              time: beat.time,
              draggable: true,
              label,
            })
          } else {
            peaks.updatePoint({ id, label, time: beat.time });
          }
        }
        for (const beat of region.autoBeats) {
          const id = autoBeatIdToString(beat.id);
          stillExistingIds.add(id);
          if (!displayedBeats.has(id)) {
            displayedBeats.add(id);
            peaks.addPoint({ 
              id, 
              time: beat.time,
              draggable: false,
            })
          } else {
            peaks.updatePoint({ id, time: beat.time });
          }
        }
      }
    }
    for (const id of displayedBeats.difference(stillExistingIds)) {
      displayedBeats.delete(id);
      peaks.deletePoint(id);
    }
  });

  $effect(() => {
    let stillExistingIds = new Set();
    if (annotate !== null) {
      for (const region of annotate.regions) {
        const id = regionIdToString(region.id);
        stillExistingIds.add(id);
        const label = (() => {
          if (region.tempo.type === 'tapped') {
            return  region.tempo.value !== null ? `${(60 / region.tempo.value.meanPeriod).toFixed(2)} bpm` : '';
          } else if (region.tempo.type === 'fixed') {
            return '';
          }
          return '';
        })();
        const segmentColors = ["#E11845", "#87E911", "#0057E9", "#FF00BD", "#F2CA19", "#8931EF"];
        const color = segmentColors[region.index % segmentColors.length];
        if (!displayedRegionSegments.has(id)) {
          displayedRegionSegments.add(id);
          peaks.addSegment({
            id,
            startTime: region.startTime,
            endTime: region.endTime,
            editable: false,
            label,
            color,
          })
        } else {
          peaks.updateSegment({
            id,
            startTime: region.startTime,
            endTime: region.endTime,
            label,
          });
        }
      }
    }
    for (const id of displayedRegionSegments.difference(stillExistingIds)) {
      displayedRegionSegments.delete(id);
      peaks.deleteSegment(id);
    }
  });

  function onZoomViewClick(e: MouseEvent, time: number) {
    if (annotate === null) {
      return;
    }
    if (e.button == 2) {
      const isTempoChange = e.getModifierState('Control');
      annotate.addPoint({ time, isTempoChange });
    }
  }

  function onPointClick(id: PointId, e: MouseEvent, preventViewEvent: () => void) {
    if (annotate === null) {
      return;
    }
    if (id.startsWith('userBeat')) {
      if (e.button === 2) {
        preventViewEvent();
        annotate.deletePoint(stringTouUserBeatId(id));
      }
    }
  }

  function onPointDrag(id: PointId, time: number, what: 'start' | 'move' | 'end') {
    if (peaks === null || annotate === null) {
      return;
    }
    const idNum = stringTouUserBeatId(id);
    const resetToTime = annotate.tryMovePoint(idNum, time, what);
    peaks.updatePoint({id, time: resetToTime});
  }

  function onPointEnter(id: PointId, time: number) {
    metronomeTik = !metronomeTik;
  }

  function onMetronomeClick() {
    const t = peaks?.getCurrentTime();
    if (isNotNullish(t) && annotate !== null) {
      annotate.addPoint({time: t, isTempoChange: false});
    }
  }

  function userBeatIdToString(id: number): string {
    return `userBeat${id}`;
  }

  function stringTouUserBeatId(str: string): number {
    console.assert(str.startsWith('userBeat'));
    return parseInt(str.slice('userBeat'.length))
  }

  function autoBeatIdToString(id: number): string {
    return `autoBeat${id}`;
  }

  function stringToAutoBeatId(str: string): number {
    console.assert(str.startsWith('autoBeat'));
    return parseInt(str.slice('autoBeat'.length))
  }

  function regionIdToString(id: number): string {
    return `region${id}`;
  }

  function stringToRegionId(str: string): number {
    console.assert(str.startsWith('region'));
    return parseInt(str.slice('region'.length))
  }

  function formatTime(seconds: number): string {
    return new Date(1000 * seconds).toISOString().substring(11, 19)
  }

  const isFixedTempo = $derived(isNotNullish(currentRegion) && currentRegion.tempo.type === 'fixed');
</script>

<header class="container">
  <hgroup>
    <h1>Tempo and Beat Annotation</h1>
  </hgroup>
</header>

<main class="container-fluid">
  <section class="container">
    <div class="grid">
      <group>
        <label for="file-input">Open audio file:</label>
        <input type="file" id="file-input" accept="audio/*" bind:files={inputFileList} />
      </group>
      <button id="button-download"
        disabled={annotate === null}
        onclick={onDownloadClicked}
      >Download Annotations</button>
      <button id="button-delete-all" class="outline">Delete All Points</button>
    </div>
  </section>
  <section class="container-fluid">
    <div class="menuGrid">
      <button id="button-metronome" 
        class={"contrast " + (metronomeTik ? 'outline' : '')}
        onclick={onMetronomeClick}
        style="transition: none; flex: 1 1 auto;">Tap</button>
      <button id="button-play" 
        style="flex: 1 1 auto;;"
        onclick={() => { isPlaying = !isPlaying; }}>Play/Pause</button>
      <article style="min-height: 300px; width: 50%; flex: 1 1 auto; display: flex; flex-direction: column;">
        <div id="region-overview"></div>
        <h4>Tempo region {currentRegion?.index ?? '-'}</h4>

        <p>
          Time: {isNotNullish(currentRegion) ? `${formatTime(currentRegion.startTime)} - ${formatTime(currentRegion.endTime)}` : '-'}
        </p>

        <p>
          {currentRegion?.userBeats?.length ?? 0} marked beats
        </p>

        <label>
          <input type="checkbox" 
            bind:checked={
            () => isFixedTempo,
            (value) => { 
              if (isNotNullish(annotate) && isNotNullish(currentRegion)) {
                annotate.setRegionType(currentRegion.id, value ? 'fixed' : 'tapped');
              }
            }
            }/>
          Fixed tempo
        </label>
        {#if isNotNullish(currentRegion) && currentRegion.tempo.type === 'tapped'}
          {@const bpm = currentRegion.tempo.value !== null ? (60 / currentRegion.tempo.value.meanPeriod).toFixed(2) : null}
          {@const stddev = currentRegion.tempo.value !== null ? currentRegion.tempo.value.stddev.toFixed(2) : null}
          <p>Mean BPM: {bpm ?? '-'}</p>
          <p>Std. dev.: {stddev ?? '-'}</p>
        {:else}
          <input type="number" 
            placeholder="bpm"
            bind:value={
            () => {
              if (isNotNullish(annotate) && isNotNullish(annotate.selectedRegion) && annotate.selectedRegion.tempo.type === 'fixed') {
                return annotate.selectedRegion.tempo.bpm;
              }
              return null
            },
            (value) => {
              if (isNotNullish(value) && 0 < value && value < MAX_TEMPO) {
                if (isNotNullish(annotate) && isNotNullish(annotate.selectedRegion) && annotate.selectedRegion.tempo.type === 'fixed') {
                  annotate.setRegionFixedTempo(annotate.selectedRegion.id, value);
                }
              }
            }
            }
            disabled={!isFixedTempo}/>
        {/if}

        <!-- <label for="checkbox-offbeat"> -->
        <!--   <input type="checkbox" id="checkbox-offbeat"> -->
        <!--   Marks are offbeats -->
        <!-- </label> -->
      </article>
    </div>
    <audio bind:this={audioEl} id="audio">
      <source src="/royaltyfreetypebeat.opus" />
    </audio>
    <Peaks
      bind:this={peaks}
      bind:isReady={peaksReady}
      bind:playerTime
      bind:viewRange
      bind:totalDuration
      bind:currentSegmentId={getCurrentSegment as () => string, onCurrentSegmentChanged}
      {onZoomViewClick}
      {onPointClick}
      {onPointEnter}
      {onPointDrag}
      {audioEl}
      {isPlaying}
    />
  </section>
</main>
<footer class="container">
  <div class="grid">
    <ul>
      <li><kbd>Space</kbd> to play/pause</li>
      <li><kbd>Left click</kbd> to move the playhead</li>
      <li><kbd>Scroll</kbd> to... scroll</li>
      <li><kbd>Right click</kbd> to place a beat</li>
      <li><kbd>Right click</kbd> it again to delete it</li>
      <li><kbd>Ctrl</kbd>+<kbd>Right click</kbd> to mark a tempo change</li>
    </ul>
    <ul>
      <li>
        Placing two beats will calculate the tempo and show where following beats will land
        according to that tempo.
      </li>
      <li>
        If the tempo changes at some point, mark it by placing a tempo change to end the previous
        constant tempo region.
      </li>
      <!-- <li> -->
      <!-- In some cases, the offbeats (e.g., snare drum) are easier to identify, which will be noted in the resulting annotations. -->
      <!-- </li> -->
    </ul>
  </div>
</footer>

<style>
.menuGrid {
  display: flex;
  flex-direction: row;
  width: 100%;
}
</style>
