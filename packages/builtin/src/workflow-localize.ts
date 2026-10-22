import type { Context } from 'cordis'
import { type WorkflowDefinition, type JsonObject, type Diagnostic, type CatalogService, type WorkflowPlan, type ExactProviderBinding } from '@dubvibe_mini/sdk'
import { videoSource } from '@dubvibe_mini/sdk/video-source'
import { operations } from './media-contracts.js'

export const name = 'workflow-localize'
export const inject = ['catalog', 'settings']
const labels: Record<string, string> = { download: 'Download video', cut: 'Cut video', prepare: 'Prepare media', separate: 'Separate vocals', recognize: 'Speech recognition', translate: 'Translate', reference: 'Prepare reference audio', synthesize: 'Generate dubbing', mix: 'Mix audio', align: 'Align subtitles', export: 'Export' }
const selection = (extra: JsonObject = {}) => ({ type: 'object', required: ['adapter', 'model', 'device'], additionalProperties: false,
  properties: { adapter: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1 }, device: { type: 'string', minLength: 1 }, ...extra } })
const nullable = (schema: JsonObject) => ({ anyOf: [schema, { type: 'null' }] })
// The optional translation fallback chain mirrors the backend TaskConfig
// contract; defaults saved through the API round-trip both keys.
export const localizeSchema: JsonObject = {
  type: 'object', additionalProperties: false,
  required: ['source_language', 'target_language', 'output_mode', 'keep_background', 'asr', 'translation', 'tts', 'separation'],
  properties: {
    source_url: { type: 'string', minLength: 1, maxLength: 2048 },
    source_language: { type: 'string', minLength: 2 }, target_language: { type: 'string', minLength: 2 },
    output_mode: { enum: ['subtitles', 'dubbing', 'both'] }, keep_background: { type: 'boolean' },
    asr: selection({ initial_prompt: { type: ['string', 'null'], maxLength: 500 } }), translation: selection(),
    translation_providers: nullable({ type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }),
    translation_models: nullable({ type: 'object', additionalProperties: { type: 'string', minLength: 1 } }),
    tts: nullable(selection({ voice: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'source_clone' } } },
      { type: 'object', additionalProperties: false, required: ['mode', 'id'], properties: { mode: { const: 'preset' }, id: { type: 'string', minLength: 1 } } },
    ] } })),
    separation: nullable(selection()), subtitle_alignment: nullable(selection()),
    trim: nullable({ type: 'object', additionalProperties: false, required: ['start_ms', 'end_ms'],
      properties: { start_ms: { type: 'integer', minimum: 0 }, end_ms: { type: 'integer', minimum: 1 } } }),
  },
}
export async function apply(ctx: Context, plugin: { integrity: string; version?: string }) {
  const version = plugin.version ?? '1.0.0', pluginId = 'youdub.workflow-localize'
  let settings = await ctx.settings.read()
  ctx.on('settings/updated', updated => { settings = updated })
  const first = (capability: string) => {
    const provider = ctx.catalog.listProviders().find(item => item.capability === capability && item.available)
    const model = provider?.models?.[0]
    return provider && model ? { adapter: provider.adapter ?? provider.id, model: model.id, device: model.devices[0] } : null
  }
  // Khmer is the product's default target language for fresh installations;
  // this legacy fallback was silent Chinese and overrode the UI default.
  const defaults = () => settings.defaults ?? { source_language: 'auto', target_language: 'km', output_mode: 'subtitles', keep_background: false, asr: first('asr'), translation: first('translation'), tts: null, separation: null, subtitle_alignment: null, trim: null }
  const pick = (kind: string, config: JsonObject, catalog: CatalogService) => catalog.listProviders().find(item => item.capability === kind && (item.adapter ?? item.id) === config[kind]?.adapter)
  const workflow: WorkflowDefinition = {
    id: 'youdub.localize', version, pluginId, pluginVersion: version, integrity: plugin.integrity,
    describe: () => ({ id: 'youdub.localize', version, label: 'Video translation and dubbing', inputs: [{ name: 'video', label: 'Video', required: false, acceptedMimeTypes: ['video/*'], maxBytes: Number(process.env.LOCAL_UPLOAD_MAX_BYTES ?? 4294967296) }], configSchema: localizeSchema, defaults: structuredClone(defaults()), ui: { editor: 'youdub.localize', sourceUrlInput: 'video' } }),
    validate: async (inputs, config, catalog) => {
      const errors: Diagnostic[] = []
      const fail = (message: string, field?: string) => errors.push({ code: 'INVALID_CONFIG', message, field })
      if (Boolean(inputs.video) === Boolean(config.source_url)) fail('Choose a local video or paste a video link.', 'video')
      if (config.source_url) {
        try { videoSource(config.source_url) } catch (error) { fail((error as Error).message, 'source_url') }
        const downloader = catalog.listProviders().find(provider => provider.id === 'youdub.download')
        if (!downloader?.available) fail(downloader?.unavailableReason || 'Video download service is unavailable.', 'source_url')
      }
      const media = catalog.listProviders().find(provider => provider.id === 'youdub.media')
      if (!media?.available) fail(media?.unavailableReason || 'FFmpeg / Media is unavailable.', 'video')
      if (config.source_language.toLowerCase() === config.target_language.toLowerCase() || config.target_language === 'auto') fail('Source and target languages must differ.', 'target_language')
      if (config.output_mode === 'subtitles' && (config.tts || config.separation || config.keep_background)) fail('Subtitles mode requires no TTS, separation, or background mix.')
      if (config.output_mode !== 'subtitles' && (!config.tts || !config.tts.voice)) fail('Dubbing requires a TTS provider and voice.')
      if (config.subtitle_alignment && config.output_mode !== 'both') fail('Subtitle alignment requires both mode.')
      const trim = config.trim as { start_ms?: unknown; end_ms?: unknown } | null | undefined
      if (trim) {
        const { start_ms: start, end_ms: end } = trim
        if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)
          || start < 0 || end <= start) fail('The clip must end after it starts.', 'trim')
        else if (end - start < 1000) fail('The clip must be at least one second long.', 'trim')
        else if (end - start > 86_400_000) fail('The clip must be shorter than 24 hours.', 'trim')
      }
      const needsSeparation = config.keep_background || config.tts?.voice?.mode === 'source_clone'
      if (needsSeparation !== Boolean(config.separation)) fail('Separation must match the background and voice requirements.', 'separation')
      const connections = (await ctx.settings.read()).connections
      for (const kind of ['asr', 'translation', 'tts', 'separation', 'subtitle_alignment']) {
        const selection = config[kind]; if (!selection) continue
        const provider = pick(kind, config, catalog)
        if (!provider?.available) { fail(provider?.unavailableReason || `Provider ${selection.adapter} is unavailable.`, `${kind}.adapter`); continue }
        const model = provider.models?.find(item => item.id === selection.model)
        if (!model || !model.devices.includes(selection.device)) { fail('Selected model or device is unavailable.', `${kind}.model`); continue }
        if (['asr', 'translation'].includes(kind) && config.source_language !== 'auto' && !model.source_languages.includes(config.source_language)) fail('Source language is unsupported.', 'source_language')
        if (['translation', 'tts', 'subtitle_alignment'].includes(kind) && !model.target_languages.includes(config.target_language)) fail('Target language is unsupported.', 'target_language')
        if (kind === 'tts') {
          if (!model.voice_modes.includes(selection.voice.mode)) fail('Selected voice mode is unsupported.', 'tts.voice')
          if (selection.voice.mode === 'preset' && !model.voices?.some((voice: any) => voice.id === selection.voice.id && voice.languages.includes(config.target_language))) fail('Selected preset voice is unavailable.', 'tts.voice.id')
        }
        if (provider.execution === 'remote' && provider.requires_api_key !== false && !connections.some((connection: any) => connection.adapter === selection.adapter && connection.base_url && connection.has_api_key)) fail('Provider connection is not configured.', `${kind}.adapter`)
      }
      return errors
    },
    plan: (_, config, catalog) => {
      const plan: WorkflowPlan = { workflow: { id: workflow.id, version, pluginId, pluginVersion: version, integrity: plugin.integrity }, config: structuredClone(config), bindings: {}, steps: [], outputs: [], omittedSteps: [] }
      const binding = (key: string, providerId: string, selection: JsonObject = {}) => {
        const provider = catalog.provider(providerId).describe()
        const options = { sourceLanguage: config.source_language, targetLanguage: config.target_language, outputMode: config.output_mode, keepBackground: config.keep_background, voice: config.tts?.voice, initialPrompt: config.asr?.initial_prompt, maxCompletionTokens: 65535 }
        plan.bindings[key] = { pluginId: provider.pluginId, pluginVersion: provider.pluginVersion, integrity: provider.integrity, providerId, model: selection.model, modelRevision: null, device: selection.device, options: JSON.parse(JSON.stringify(options)) } satisfies ExactProviderBinding
      }
      binding('media', 'youdub.media')
      if (config.source_url) {
        binding('download', 'youdub.download')
        // A clip range makes the source duration irrelevant to the output, so
        // long videos stay downloadable; the cut segment is admission-checked.
        plan.bindings.download.options = { maxBytes: Number(process.env.LOCAL_UPLOAD_MAX_BYTES ?? 4294967296),
          ...(config.trim ? { maxDurationMs: 86_400_000 } : {}) }
        plan.config.source_url = videoSource(config.source_url).url
      }
      for (const kind of ['asr', 'translation', 'tts', 'separation', 'subtitle_alignment']) if (config[kind]) binding(kind, pick(kind, config, catalog)!.id, config[kind])
      const task = (name: string) => ({ from: 'task' as const, name })
      const step = (stepId: string, output: string) => ({ from: 'step' as const, stepId, output })
      const add = (id: string, bindingKey: string, input: JsonObject) => { const operation = operations[id]; plan.steps.push({ id, label: labels[id], bindingKey, operation: operation.id, input, outputs: structuredClone(operation.outputs) }) }
      if (config.source_url) add('download', 'download', { url: plan.config.source_url })
      let video = config.source_url ? step('download', 'video') : task('video')
      if (config.trim) {
        const { start_ms: start, end_ms: end } = config.trim as { start_ms: number; end_ms: number }
        add('cut', 'media', { video, start_ms: start, end_ms: end })
        video = step('cut', 'video')
      }
      add('prepare', 'media', { video })
      if (config.separation) add('separate', 'separation', { sourceAudio: step('prepare', 'sourceAudio') })
      add('recognize', 'asr', { audio: config.separation ? step('separate', 'vocals') : step('prepare', 'sourceAudio'), mediaInfo: step('prepare', 'mediaInfo') })
      add('translate', 'translation', { transcript: step('recognize', 'transcript') })
      if (config.tts) {
        if (config.tts.voice.mode === 'source_clone') add('reference', 'media', { transcript: step('recognize', 'transcript'), audio: step('separate', 'vocals') })
        else plan.omittedSteps!.push({ id: 'reference', reason: 'Preset voice does not require source references.' })
        add('synthesize', 'tts', { transcript: step('recognize', 'transcript'), translation: step('translate', 'translation'), ...(config.tts.voice.mode === 'source_clone' ? { references: step('reference', 'references') } : {}) })
        add('mix', 'media', { transcript: step('recognize', 'transcript'), speechAudio: step('synthesize', 'speechAudio'), mediaInfo: step('prepare', 'mediaInfo'), ...(config.keep_background ? { background: step('separate', 'background') } : {}) })
        if (config.subtitle_alignment) add('align', 'subtitle_alignment', { transcript: step('recognize', 'transcript'), translation: step('translate', 'translation'), dubbedTimeline: step('mix', 'dubbedTimeline'), adjustedSpeech: step('mix', 'adjustedSpeech') })
        else plan.omittedSteps!.push({ id: 'align', reason: 'Model subtitle alignment is disabled.' })
      }
      add('export', 'media', { video, mediaInfo: step('prepare', 'mediaInfo'), transcript: step('recognize', 'transcript'), translation: step('translate', 'translation'), ...(config.tts ? { finalAudio: step('mix', 'finalAudio'), dubbedTimeline: step('mix', 'dubbedTimeline') } : {}), ...(config.subtitle_alignment ? { wordAlignment: step('align', 'wordAlignment') } : {}) })
      const final = (id: string, output: string, label: string) => plan.outputs.push({ id, label, role: id, source: { stepId: 'export', output }, required: true })
      final('video', 'video', 'Video')
      if (config.output_mode !== 'subtitles') final('audio', 'audio', 'Dubbed audio')
      if (config.output_mode !== 'dubbing') { final('source_subtitles', 'sourceSubtitles', 'Source subtitles'); final('translated_subtitles', 'translatedSubtitles', 'Translated subtitles') }
      return plan
    },
  }
  ctx.effect(() => ctx.catalog.registerWorkflow(workflow))
}
