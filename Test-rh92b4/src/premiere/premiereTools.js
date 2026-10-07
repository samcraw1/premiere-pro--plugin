// Every Premiere Pro (UXP) call the panel uses lives here.
// Reference: https://developer.adobe.com/premiere-pro/uxp/ppro-reference/
//
// TABLE OF CONTENTS (search for the "== Section ==" banners)
//   Core            getProject, runTransaction, secondsToTicks, ticksToSeconds, getAppVersion
//   Bins & import   collectBins, collectClips, findProjectItems, importFiles, createBin, moveItemsToBin, renameBin
//   Clips           renameItem, setColorLabel, setOffline, getMediaPath, relinkMedia,
//                   findItemsByMediaPath, refreshMedia, attachProxy
//   Project         saveProject, saveProjectAs, openProject, closeProject
//   Sequences       listSequences, getActiveSequence, setActiveSequence, openSequence,
//                   createSequence, createSequenceFromClips, cloneSequence, createSubsequence
//   Timeline        insertClip, overwriteClip, getPlayhead, setPlayhead, getInOut, setInOut,
//                   getSequenceEnd, removeSelection
//   Media Encoder   isAMEInstalled, launchEncoder, sendSequenceToAME, sendClipToAME, sendFileToAME,
//                   startAMEQueue, onRenderEvents, exportStillFrame
//   Markers         addMarker, listMarkers, moveMarker, removeMarker
//   Transcripts     transcribeClip, hasTranscript, isLanguagePackAvailable, supportedLanguages,
//                   exportTranscriptJSON, importTranscriptJSON
//
// Rules that apply to everything below:
//  - premierepro is required lazily inside functions, like the rest of the panel.
//  - Anything that changes the project goes through runTransaction(). Its callbacks must be
//    synchronous: do every await BEFORE calling it, or Premiere throws
//    "The script object is no longer valid".
//  - Functions throw Errors with readable messages; callers decide how to show them.

const ppro = () => require("premierepro")

// == Core ==

/** The active project, or a readable Error when none is open. */
export async function getProject() {
  const project = await ppro().Project.getActiveProject()
  if (!project) {
    const error = new Error("No active Premiere project - open a project first.")
    error.code = 404
    throw error
  }
  return project
}

/**
 * Runs undoable actions as one transaction. `build(add)` is synchronous and calls
 * add(action) for each action; falsy actions are skipped. Returns Premiere's success flag.
 */
export function runTransaction(project, undoLabel, build) {
  let ok = false
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => {
      build((action) => {
        if (action) compound.addAction(action)
      })
    }, undoLabel)
  })
  return ok
}

export function secondsToTicks(seconds) {
  return ppro().TickTime.createWithSeconds(seconds)
}

export function ticksToSeconds(tickTime) {
  return tickTime.seconds
}

/** Premiere version string (needs Premiere 25.6+). */
export async function getAppVersion() {
  return await ppro().app.version
}

function asClip(item) {
  return ppro().ClipProjectItem.cast(item)
}

function asFolder(item) {
  try {
    return ppro().FolderItem.cast(item)
  } catch {
    return null
  }
}

// == Bins & import ==

/** Every bin under `folder` as { id, name ("A / B" path), item }. */
export async function collectBins(folder, prefix = "") {
  const found = []
  const items = await folder.getItems()
  for (const item of items) {
    const bin = asFolder(item)
    if (!bin) continue
    const name = prefix ? `${prefix} / ${item.name}` : item.name
    found.push({ id: item.guid?.toString() ?? name, name, item: bin })
    found.push(...(await collectBins(bin, name)))
  }
  return found
}

/**
 * Names of every non-folder item (clips, sequences, ...) with the bin path each lives in,
 * so the assistant can answer questions about the project.
 */
export async function collectClips(folder, prefix = "") {
  const found = []
  const items = await folder.getItems()
  for (const item of items) {
    const bin = asFolder(item)
    if (bin) {
      const name = prefix ? `${prefix} / ${item.name}` : item.name
      found.push(...(await collectClips(bin, name)))
    } else {
      found.push({ name: item.name, bin: prefix })
    }
  }
  return found
}

/**
 * Resolves {name, bin} pairs (as listed by collectClips) back to live ProjectItems so they can
 * be moved. `wanted` is a Set of `${bin}\u0000${name}` keys. Async, so run it before any transaction.
 */
export async function findProjectItems(folder, wanted, prefix = "") {
  const found = []
  const items = await folder.getItems()
  for (const item of items) {
    const bin = asFolder(item)
    if (bin) {
      const name = prefix ? `${prefix} / ${item.name}` : item.name
      found.push(...(await findProjectItems(bin, wanted, name)))
    } else if (wanted.has(`${prefix}\u0000${item.name}`)) {
      found.push(item)
    }
  }
  return found
}

/** Imports files into a bin (FolderItem) or the project root when `targetFolder` is null. */
export async function importFiles(filePaths, targetFolder = null, project = null) {
  const target = project ?? (await getProject())
  return await target.importFiles(filePaths, true, targetFolder, false)
}

/**
 * Finds a bin by name (case-insensitive, full "A / B" path) or creates it at the project root.
 * Returns { id, name, item }.
 */
export async function createBin(name) {
  const project = await getProject()
  const root = await project.getRootItem()
  const find = async () =>
    (await collectBins(root)).find((b) => b.name.toLowerCase() === name.toLowerCase())

  const existing = await find()
  if (existing) return existing

  runTransaction(project, "Create bin", (add) => add(root.createBinAction(name, true)))
  const created = await find()
  if (!created) throw new Error(`Could not create bin "${name}".`)
  return created
}

/** Moves project items into a bin ({ item: FolderItem } as returned by createBin/collectBins). */
export async function moveItemsToBin(items, bin) {
  const project = await getProject()
  const root = await project.getRootItem()
  return runTransaction(project, "Move items to bin", (add) => {
    for (const item of items) add(root.createMoveItemAction(item, bin.item))
  })
}

export async function renameBin(folderItem, name) {
  const project = await getProject()
  return runTransaction(project, "Rename bin", (add) => add(folderItem.createRenameBinAction(name)))
}

// == Clips ==

export async function renameItem(item, name) {
  const project = await getProject()
  const clip = asClip(item)
  return runTransaction(project, "Rename item", (add) => add(clip.createSetNameAction(name)))
}

/** `labelIndex` is Premiere's color label index. */
export async function setColorLabel(item, labelIndex) {
  const project = await getProject()
  const clip = asClip(item)
  return runTransaction(project, "Set color label", (add) => add(clip.createSetColorLabelAction(labelIndex)))
}

export async function setOffline(item) {
  const project = await getProject()
  const clip = asClip(item)
  return runTransaction(project, "Set offline", (add) => add(clip.createSetOfflineAction()))
}

export async function getMediaPath(item) {
  return await asClip(item).getMediaFilePath()
}

export async function relinkMedia(item, newPath, overrideCompatibilityCheck = false) {
  const clip = asClip(item)
  if (!(await clip.canChangeMediaPath())) throw new Error("This item's media path can't be changed.")
  return await clip.changeMediaFilePath(newPath, overrideCompatibilityCheck)
}

/**
 * Items under `folder` whose media path contains `match` (case-insensitive). Walks the project
 * itself instead of using ClipProjectItem.findItemsMatchingMediaPath, whose semantics are unclear.
 */
export async function findItemsByMediaPath(folder, match) {
  const needle = match.toLowerCase()
  const found = []
  const items = await folder.getItems()
  for (const item of items) {
    const bin = asFolder(item)
    if (bin) {
      found.push(...(await findItemsByMediaPath(bin, match)))
      continue
    }
    try {
      const path = await asClip(item).getMediaFilePath()
      if (path && path.toLowerCase().includes(needle)) found.push(item)
    } catch {
      // sequences and other non-media items have no file path
    }
  }
  return found
}

export async function refreshMedia(item) {
  return await asClip(item).refreshMedia()
}

export async function attachProxy(item, proxyPath, isHighRes = false) {
  const clip = asClip(item)
  if (!(await clip.canProxy())) throw new Error("A proxy can't be attached to this item.")
  return await clip.attachProxy(proxyPath, isHighRes, false)
}

// == Project ==

export async function saveProject() {
  return await (await getProject()).save()
}

export async function saveProjectAs(path) {
  return await (await getProject()).saveAs(path)
}

export async function openProject(path) {
  return await ppro().Project.open(path)
}

export async function closeProject() {
  return await (await getProject()).close()
}

// == Sequences ==

export async function listSequences() {
  return await (await getProject()).getSequences()
}

export async function getActiveSequence() {
  return await (await getProject()).getActiveSequence()
}

export async function setActiveSequence(sequence) {
  return await (await getProject()).setActiveSequence(sequence)
}

/** Opens the sequence in a timeline panel and makes it active. */
export async function openSequence(sequence) {
  return await (await getProject()).openSequence(sequence)
}

export async function createSequence(name, presetPath) {
  return await (await getProject()).createSequence(name, presetPath)
}

/** `clips` are project items; `bin` is { item } from createBin/collectBins, or null for the project root. */
export async function createSequenceFromClips(name, clips, bin = null) {
  const project = await getProject()
  const target = bin?.item ?? (await project.getRootItem())
  return await project.createSequenceFromMedia(name, clips.map(asClip), target)
}

export async function cloneSequence(sequence) {
  const project = await getProject()
  return runTransaction(project, "Clone sequence", (add) => add(sequence.createCloneAction()))
}

export async function createSubsequence(sequence, ignoreTrackTargeting = false) {
  return await sequence.createSubsequence(ignoreTrackTargeting)
}

// == Timeline ==

/** Inserts a project item at `seconds`, shifting later clips. Track indexes are zero-based. */
export async function insertClip(sequence, item, seconds, videoTrack = 0, audioTrack = 0, limitShift = false) {
  const project = await getProject()
  const editor = ppro().SequenceEditor.getEditor(sequence)
  return runTransaction(project, "Insert clip", (add) =>
    add(editor.createInsertProjectItemAction(item, secondsToTicks(seconds), videoTrack, audioTrack, limitShift))
  )
}

/** Like insertClip but overwrites whatever is there. */
export async function overwriteClip(sequence, item, seconds, videoTrack = 0, audioTrack = 0) {
  const project = await getProject()
  const editor = ppro().SequenceEditor.getEditor(sequence)
  return runTransaction(project, "Overwrite clip", (add) =>
    add(editor.createOverwriteItemAction(item, secondsToTicks(seconds), videoTrack, audioTrack))
  )
}

export async function getPlayhead(sequence) {
  return ticksToSeconds(await sequence.getPlayerPosition())
}

export async function setPlayhead(sequence, seconds) {
  return await sequence.setPlayerPosition(secondsToTicks(seconds))
}

/** In/out points in seconds. */
export async function getInOut(sequence) {
  const [inPoint, outPoint] = await Promise.all([sequence.getInPoint(), sequence.getOutPoint()])
  return { in: ticksToSeconds(inPoint), out: ticksToSeconds(outPoint) }
}

export async function setInOut(sequence, inSeconds, outSeconds) {
  const project = await getProject()
  return runTransaction(project, "Set in/out", (add) => {
    add(sequence.createSetInPointAction(secondsToTicks(inSeconds)))
    add(sequence.createSetOutPointAction(secondsToTicks(outSeconds)))
  })
}

export async function getSequenceEnd(sequence) {
  return ticksToSeconds(await sequence.getEndTime())
}

/** Deletes the items currently selected on the timeline; `ripple` closes the gap. */
export async function removeSelection(sequence, ripple = false) {
  const project = await getProject()
  const editor = ppro().SequenceEditor.getEditor(sequence)
  const selection = await sequence.getSelection()
  return runTransaction(project, "Remove selection", (add) =>
    add(editor.createRemoveItemsAction(selection, ripple, ppro().Constants.MediaType.ANY, false))
  )
}

// ==PhotoShop ==
// PLACEHOLDER: premierepro has no Photoshop API in Premiere 26.5.0 (checked in the debug
// console), so these throw a TypeError. Do not call them until a Premiere version adds one.

function getPhotoshop(){
  return ppro().Photoshop.getPhotoshop()
}

function requirePhotoshop() {
  if(! getPhotoshop()) throw new Error("Adobe Photoshop isn't installed.")
}

export function isPhotoshopInstalled(){
  return Boolean(getPhotoshop().isPhotoshopInstalled)
}

export async function launchPhotoshop(){
  requirePhotoshop()
  return await getPhotoshop().launchPhotoshop()
}


// == Media Encoder ==

function getEncoder() {
  return ppro().EncoderManager.getManager()
}

function requireAME() {
  if (!getEncoder().isAMEInstalled) throw new Error("Adobe Media Encoder isn't installed.")
}

export function isAMEInstalled() {
  return Boolean(getEncoder().isAMEInstalled)
}

export async function launchEncoder() {
  requireAME()
  return await getEncoder().launchEncoder()
}

/**
 * Sends a sequence to the Media Encoder queue. `outputPath` and `presetPath` (.epr) are optional;
 * without them AME uses the sequence's export settings. `startQueue` begins encoding immediately.
 */
export async function sendSequenceToAME(sequence, outputPath, presetPath, { startQueue = false, exportFull = true } = {}) {
  requireAME()
  const encoder = getEncoder()
  const ok = await encoder.exportSequence(
    sequence,
    ppro().Constants.ExportType.QUEUE_TO_AME,
    outputPath,
    presetPath,
    exportFull
  )
  if (ok && startQueue) await encoder.startBatchEncode()
  return ok
}

/** Sends a project clip to the Media Encoder queue. */
export async function sendClipToAME(item, outputPath, presetPath, { workArea = 0, removeUponCompletion = false, startQueue = false } = {}) {
  requireAME()
  return await getEncoder().encodeProjectItem(asClip(item), outputPath, presetPath, workArea, removeUponCompletion, startQueue)
}

/** Sends a file on disk to the Media Encoder queue, optionally trimmed to inSeconds..outSeconds. */
export async function sendFileToAME(filePath, outputPath, presetPath, { inSeconds = 0, outSeconds = 0, workArea = 0, removeUponCompletion = false, startQueue = false } = {}) {
  requireAME()
  return await getEncoder().encodeFile(
    filePath,
    outputPath,
    presetPath,
    secondsToTicks(inSeconds),
    secondsToTicks(outSeconds),
    workArea,
    removeUponCompletion,
    startQueue
  )
}

/** Starts processing whatever is in the AME queue. */
export async function startAMEQueue() {
  requireAME()
  return await getEncoder().startBatchEncode()
}

/**
 * Listens for Media Encoder events. Pass any of { progress, complete, error, queued, canceled }
 * handlers; returns a function that removes them all.
 */
export function onRenderEvents(handlers) {
  const EncoderManager = ppro().EncoderManager
  const encoder = getEncoder()
  const events = {
    progress: EncoderManager.EVENT_RENDER_PROGRESS,
    complete: EncoderManager.EVENT_RENDER_COMPLETE,
    error: EncoderManager.EVENT_RENDER_ERROR,
    queued: EncoderManager.EVENT_RENDER_QUEUE,
    canceled: EncoderManager.EVENT_RENDER_CANCEL,
  }
  const attached = []
  for (const [key, eventName] of Object.entries(events)) {
    if (typeof handlers[key] !== "function") continue
    ppro().EventManager.addEventListener(encoder, eventName, handlers[key], false)
    attached.push([eventName, handlers[key]])
  }
  return () => {
    for (const [eventName, handler] of attached) {
      ppro().EventManager.removeEventListener(encoder, eventName, handler)
    }
  }
}

/** Saves one frame as an image (png, jpg, tif, ...; the extension in `filename` picks the format). */
export async function exportStillFrame(sequence, seconds, directory, filename, width, height) {
  return await ppro().Exporter.exportSequenceFrame(sequence, secondsToTicks(seconds), filename, directory, width, height)
}

// == Markers ==

/** `target` is a Sequence or a clip project item. `type` is a marker type string, "Comment" by default. */
export async function addMarker(target, { name = "", type = "Comment", seconds = 0, duration = 0, comments = "" } = {}) {
  const project = await getProject()
  const markers = ppro().Markers.getMarkers(target)
  return runTransaction(project, "Add marker", (add) =>
    add(markers.createAddMarkerAction(name, type, secondsToTicks(seconds), secondsToTicks(duration), comments))
  )
}

export async function listMarkers(target, filters) {
  return await ppro().Markers.getMarkers(target).getMarkers(filters)
}

export async function moveMarker(target, marker, seconds) {
  const project = await getProject()
  const markers = ppro().Markers.getMarkers(target)
  return runTransaction(project, "Move marker", (add) => add(markers.createMoveMarkerAction(marker, secondsToTicks(seconds))))
}

export async function removeMarker(target, marker) {
  const project = await getProject()
  const markers = ppro().Markers.getMarkers(target)
  return runTransaction(project, "Remove marker", (add) => add(markers.createRemoveMarkerAction(marker)))
}

// == Transcripts ==

/** Transcribes a clip's audio. `language` is a languageCode from supportedLanguages(). */
export async function transcribeClip(item, language) {
  return await ppro().Transcript.transcribeClipProjectItem(asClip(item), language ? { language } : undefined)
}

export function hasTranscript(transcriptItem) {
  return ppro().Transcript.hasTranscript(asClip(transcriptItem))
}

export function isLanguagePackAvailable(language) {
  return ppro().Transcript.isLanguagePackAvailable(language)
}

/** [{ displayString, languageCode, locale }] */
export function supportedLanguages() {
  return ppro().Transcript.querySupportedLanguages()
}

/** The clip's transcript as a JSON string. */
export async function exportTranscriptJSON(transcriptItem) {
  return await ppro().Transcript.exportToJSON(asClip(transcriptItem))
}

/** Attaches transcript text (a JSON string in the format exportTranscriptJSON produces) to a clip. */
export async function importTranscriptJSON(transcriptItem, jsonString) {
  const project = await getProject()
  const clip = asClip(transcriptItem)
  const segments = ppro().Transcript.importFromJSON(jsonString)
  return runTransaction(project, "Import transcript", (add) =>
    add(ppro().Transcript.createImportTextSegmentsAction(segments, clip))
  )
}

export async function adjustAudio(audioTrackItem, deltaDb) {
  const project = await getProject()
// grab the audio track from the clip
 const chain = await audioTrackItem.getComponentChain()
  if(!chain || (await chain.getComponentCount()) === 0) throw new Error("Missing audio track")
  //find the volume component within the chain

  const componentCount = await chain.getComponentCount()
    let volumeComponent = null

for (let i = 0; i < componentCount; i++){
  const component = await chain.getComponentAtIndex(i)
  if(await component.getDisplayName() === "Volume"){
    volumeComponent = component
    break
  }
}
if(!volumeComponent) throw new Error("Missing volume component")
  
  
  const level = await volumeComponent.getParamCount()
    if(!level) throw new Error("Missing audio level")
  let levelParam = null

    for (let i = 0; i < level; i++){
      const param = await volumeComponent.getParam(i)
      if(param.displayName === "Level"){
        levelParam = param
        break
      }
    }
    if(!levelParam) throw new Error("Missing audio level parameter")

  if(levelParam.isTimeVarying()){
    throw new Error("Time-varying audio levels are not supported yet")
  }

  const levelValue = (await levelParam.getStartValue()).value.value
  const newLevelValue = levelValue * 10 ** (deltaDb / 20)

  runTransaction(project, "Adjust audio level", (add) =>
    add(levelParam.createSetValueAction(levelParam.createKeyframe(newLevelValue)))
  )
  return newLevelValue
}

/**
 * Applies adjustAudio to every audio clip selected on the active timeline.
 * Selected video clips are skipped. Returns how many clips were changed.
 */
export async function adjustSelectedAudio(deltaDb) {
  const sequence = await getActiveSequence()
  if (!sequence) throw new Error("No active sequence - open a sequence first.")
  const selected = await (await sequence.getSelection()).getTrackItems()

  let changed = 0
  let firstError = null
  for (const trackItem of selected) {
    try {
      await adjustAudio(trackItem, deltaDb)
      changed++
    } catch (err) {
      firstError = firstError ?? err
    }
  }
  if (changed === 0) {
    throw firstError ?? new Error("Select an audio clip on the timeline first.")
  }
  return changed
}
