<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Marked } from 'marked';

	const marked = new Marked();

	interface ChartItem {
		tool_use_id: string;
		chart_spec: string;
	}

	interface TableItem {
		title: string;
		tool_use_id: string;
		result_set: {
			resultSetMetaData: { rowType: Array<{ name: string; type: string }> };
			data: string[][];
		};
	}

	interface Message {
		role: 'user' | 'assistant';
		content: string;
		html: string;
		status: string;
		charts: ChartItem[];
		tables: TableItem[];
		suggestedQueries: string[];
	}

	let messages = $state<Message[]>([]);
	let inputMessage = $state('');
	let chatLoading = $state(false);
	let autoSpeak = $state(true);

	// Voice state
	let isRecording = $state(false);
	let isTranscribing = $state(false);
	let isSpeaking = $state(false);
	let speakingIndex = $state(-1);
	let mediaRecorder: MediaRecorder | null = null;
	let audioChunks: Blob[] = [];
	let discardTake = false;

	// TTS engine state
	let ttsState = $state<'READY' | 'STARTING' | 'SUSPENDED' | 'UNAVAILABLE'>('SUSPENDED');
	let ttsDetail = $state('');
	let ttsBusy = $state(false);
	let currentAudio: HTMLAudioElement | null = null;
	let statusPoll: ReturnType<typeof setInterval> | null = null;

	// Audio analysis for live waveform
	let audioContext: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let animationFrame: number | null = null;

	// Voice activity detection — stop recording on a natural pause instead of
	// making the user click the mic a second time.
	let autoStop = $state(true);
	let heardSpeech = $state(false);
	let vadFrame: number | null = null;

	/** Pause after speech that ends the turn. */
	const SILENCE_MS = 1300;
	/** Give up if the user never says anything. */
	const NO_SPEECH_TIMEOUT_MS = 8000;
	/** Absolute cap so a stuck mic cannot record forever. */
	const MAX_RECORDING_MS = 30000;

	// Hands-free — hold the mic open and start recording when speech is heard,
	// so a follow-up question needs no click at all.
	let handsFree = $state(false);
	let handsFreeArming = $state(false);
	let wakeStream: MediaStream | null = null;
	let wakeContext: AudioContext | null = null;
	let wakeAnalyser: AnalyserNode | null = null;
	let wakeFrame: number | null = null;
	let wakeCooldownUntil = 0;

	/** Sustained level above threshold before we treat it as a real utterance. */
	const WAKE_SUSTAIN_MS = 180;
	/** Ignore the mic briefly after a turn so its tail cannot retrigger. */
	const WAKE_COOLDOWN_MS = 700;

	let chatArea: HTMLDivElement;
	let pinnedToBottom = $state(true);
	let waveCanvas: HTMLCanvasElement;
	let vegaEmbedModule: typeof import('vega-embed') | null = null;

	const orbState = $derived(
		isRecording ? 'recording' : isSpeaking ? 'speaking' : chatLoading ? 'thinking' : 'idle'
	);

	const orbIcon = $derived(
		isRecording ? '\u23F9' : isSpeaking ? '\u{1F50A}' : isTranscribing ? '\u231B' : '\u{1F3A4}'
	);

	const statusLabel = $derived(
		isRecording
			? 'Listening...'
			: isTranscribing
				? 'Transcribing...'
				: isSpeaking
					? 'Speaking'
					: chatLoading
						? 'Thinking...'
						: 'Ready'
	);

	const statusHint = $derived(
		isRecording
			? autoStop || handsFree
				? heardSpeech
					? 'Listening — pause when you\u2019re done'
					: 'Go ahead, I\u2019m listening'
				: 'Tap the orb to stop and send'
			: isSpeaking
				? 'Tap to stop playback'
				: chatLoading
					? 'Querying 600M+ retail records'
					: handsFree
						? 'Hands-free — just start talking'
						: 'Tap the orb to speak, or type below'
	);

	onMount(() => {
		// Keep the engine badge honest — the service can come up or go down
		// outside the app (npm run tts:up / tts:down, auto-suspend). Registered
		// synchronously: Svelte ignores a cleanup returned from an async
		// onMount, which would leak this interval.
		const bgPoll = setInterval(refreshTtsStatus, 30000);

		(async () => {
			vegaEmbedModule = await import('vega-embed');
			const mermaidMod = await import('mermaid');
			mermaidMod.default.initialize({ startOnLoad: false, theme: 'dark' });
			// Warm up voice list
			window.speechSynthesis.getVoices();
			refreshTtsStatus();
		})();

		return () => {
			clearInterval(bgPoll);
			disarmHandsFree();
		};
	});

	/**
	 * Keep the newest content in view, unless the user has deliberately
	 * scrolled up to read back — yanking them to the bottom mid-read on every
	 * streamed token would be worse than not scrolling at all.
	 */
	function scrollToBottom(force = false) {
		if (!chatArea) return;
		if (!force && !pinnedToBottom) return;
		chatArea.scrollTop = chatArea.scrollHeight;
	}

	/** Within this many px of the bottom still counts as "following along". */
	const PIN_THRESHOLD_PX = 120;

	function handleChatScroll() {
		if (!chatArea) return;
		const distance = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight;
		pinnedToBottom = distance <= PIN_THRESHOLD_PX;
	}

	// ============ Live waveform ============
	function drawWaveform() {
		if (!waveCanvas || !analyser) return;
		const ctx = waveCanvas.getContext('2d');
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const w = waveCanvas.clientWidth;
		const h = waveCanvas.clientHeight;
		if (waveCanvas.width !== w * dpr) {
			waveCanvas.width = w * dpr;
			waveCanvas.height = h * dpr;
			ctx.scale(dpr, dpr);
		}

		const bufferLength = analyser.frequencyBinCount;
		const data = new Uint8Array(bufferLength);

		const render = () => {
			if (!analyser) return;
			animationFrame = requestAnimationFrame(render);
			analyser.getByteFrequencyData(data);

			ctx.clearRect(0, 0, w, h);

			const cx = w / 2;
			const cy = h / 2;
			const baseRadius = 78;
			const bars = 72;

			for (let i = 0; i < bars; i++) {
				const dataIdx = Math.floor((i / bars) * (bufferLength * 0.6));
				const amplitude = (data[dataIdx] / 255) * 42;
				const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;

				const x1 = cx + Math.cos(angle) * baseRadius;
				const y1 = cy + Math.sin(angle) * baseRadius;
				const x2 = cx + Math.cos(angle) * (baseRadius + amplitude);
				const y2 = cy + Math.sin(angle) * (baseRadius + amplitude);

				const intensity = data[dataIdx] / 255;
				const grad = ctx.createLinearGradient(x1, y1, x2, y2);
				grad.addColorStop(0, `rgba(212, 91, 144, ${0.3 + intensity * 0.7})`);
				grad.addColorStop(1, `rgba(255, 159, 54, ${intensity * 0.9})`);

				ctx.strokeStyle = grad;
				ctx.lineWidth = 2.5;
				ctx.lineCap = 'round';
				ctx.beginPath();
				ctx.moveTo(x1, y1);
				ctx.lineTo(x2, y2);
				ctx.stroke();
			}
		};
		render();
	}

	function stopWaveform() {
		if (animationFrame) {
			cancelAnimationFrame(animationFrame);
			animationFrame = null;
		}
		if (vadFrame) {
			cancelAnimationFrame(vadFrame);
			vadFrame = null;
		}
		if (waveCanvas) {
			const ctx = waveCanvas.getContext('2d');
			ctx?.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
		}
		analyser = null;
		if (audioContext) {
			audioContext.close();
			audioContext = null;
		}
	}

	// ============ Rendering ============
	async function renderMermaid() {
		const mermaidMod = await import('mermaid');
		await tick();
		const blocks = document.querySelectorAll('.mermaid:not([data-processed])');
		for (const block of blocks) {
			const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
			try {
				const { svg } = await mermaidMod.default.render(id, block.textContent || '');
				block.innerHTML = svg;
				block.setAttribute('data-processed', 'true');
			} catch {
				/* leave as-is */
			}
		}
	}

	async function renderCharts() {
		if (!vegaEmbedModule) return;
		await tick();
		const containers = document.querySelectorAll('.vega-chart:not([data-rendered])');
		for (const el of containers) {
			const specStr = el.getAttribute('data-spec');
			if (!specStr) continue;
			try {
				const spec = JSON.parse(specStr);
				spec.background = 'transparent';
				spec.config = {
					...(spec.config || {}),
					axis: { labelColor: '#7A8B9C', titleColor: '#7A8B9C', gridColor: 'rgba(41,181,232,0.08)', domainColor: 'rgba(41,181,232,0.2)' },
					legend: { labelColor: '#7A8B9C', titleColor: '#7A8B9C' },
					range: { category: ['#29B5E8', '#75CDD7', '#7D44CF', '#FF9F36', '#D45B90', '#11567F'] },
					view: { stroke: 'transparent' }
				};
				await vegaEmbedModule.default(el as HTMLElement, spec, { actions: false, renderer: 'svg' });
				el.setAttribute('data-rendered', 'true');
			} catch {
				el.textContent = 'Failed to render chart';
			}
		}
	}

	// ============ Chat ============
	async function sendMessage(text?: string) {
		const msg = text || inputMessage.trim();
		if (!msg || chatLoading) return;

		if (isSpeaking) stopSpeaking();
		inputMessage = '';
		chatLoading = true;

		messages = [
			...messages,
			{ role: 'user', content: msg, html: '', status: '', charts: [], tables: [], suggestedQueries: [] }
		];
		messages = [
			...messages,
			{ role: 'assistant', content: '', html: '', status: 'Connecting', charts: [], tables: [], suggestedQueries: [] }
		];
		const assistantMsg = messages[messages.length - 1];
		const assistantIdx = messages.length - 1;

		await tick();
		scrollToBottom(true);

		const history = messages
			.slice(0, -2)
			.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
			.map((m) => ({ role: m.role, content: m.content }));

		try {
			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: msg, history })
			});

			if (!response.ok) {
				const err = await response.json();
				assistantMsg.content = `Error: ${err.error || 'Request failed'}`;
				assistantMsg.html = assistantMsg.content;
				assistantMsg.status = '';
				chatLoading = false;
				return;
			}

			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let currentEvent = '';
			let collectedText = '';
			let dataLines: string[] = [];
			const seenChartIds = new Set<string>();
			const seenTableIds = new Set<string>();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('event:')) {
						currentEvent = line.slice(6).trim();
						dataLines = [];
					} else if (line.startsWith('data:')) {
						dataLines.push(line.slice(5));
					} else if (line.trim() === '' && dataLines.length > 0) {
						const dataStr = dataLines.join('\n').trim();
						dataLines = [];
						if (dataStr === '[DONE]') continue;

						try {
							const data = JSON.parse(dataStr);

							if (data.status === 'planning') assistantMsg.status = 'Planning query';
							if (data.status === 'executing_tool')
								assistantMsg.status = `Running ${data.tool_type || 'analysis'}`;
							if (data.status === 'proceeding_to_answer') assistantMsg.status = 'Composing answer';

							if (currentEvent === 'response.text.delta' && data.text) {
								collectedText += data.text;
								assistantMsg.content = collectedText;
								assistantMsg.html = await marked.parse(collectedText);
								assistantMsg.status = '';
								await tick();
								scrollToBottom();
							}

							if (currentEvent === 'response.chart' && data.chart_spec) {
								const key = data.tool_use_id || data.chart_spec;
								if (!seenChartIds.has(key)) {
									seenChartIds.add(key);
									assistantMsg.charts = [
										...assistantMsg.charts,
										{ tool_use_id: data.tool_use_id, chart_spec: data.chart_spec }
									];
								}
							}

							if (currentEvent === 'response.table' && data.result_set) {
								const key = data.tool_use_id || JSON.stringify(data.result_set.data?.[0]);
								if (!seenTableIds.has(key)) {
									seenTableIds.add(key);
									assistantMsg.tables = [
										...assistantMsg.tables,
										{ title: data.title, tool_use_id: data.tool_use_id, result_set: data.result_set }
									];
								}
							}

							if (currentEvent === 'response' && data.content) {
								let lastText = '';
								for (const item of data.content) {
									if (item.type === 'text' && item.text?.trim()) lastText = item.text;
									if (item.type === 'chart' && item.chart?.chart_spec) {
										const key = item.chart.tool_use_id || item.chart.chart_spec;
										if (!seenChartIds.has(key)) {
											seenChartIds.add(key);
											assistantMsg.charts = [
												...assistantMsg.charts,
												{ tool_use_id: item.chart.tool_use_id, chart_spec: item.chart.chart_spec }
											];
										}
									}
									if (item.type === 'suggested_queries' && item.suggested_queries) {
										assistantMsg.suggestedQueries = item.suggested_queries.map(
											(q: { query: string }) => q.query
										);
									}
								}
								if (lastText) {
									collectedText = lastText;
									assistantMsg.content = collectedText;
									assistantMsg.html = await marked.parse(collectedText);
								}
							}
						} catch {
							/* partial JSON */
						}
					}
				}
			}

			assistantMsg.status = '';
			if (!assistantMsg.content && !assistantMsg.charts.length && !assistantMsg.tables.length) {
				assistantMsg.content = 'No response received.';
				assistantMsg.html = 'No response received.';
			}

			await tick();
			await renderMermaid();
			await renderCharts();
			scrollToBottom(true);

			if (autoSpeak && assistantMsg.content) {
				speakText(assistantMsg.content, assistantIdx);
			}
		} catch (err) {
			assistantMsg.content = `Error: ${err instanceof Error ? err.message : 'Network error'}`;
			assistantMsg.html = assistantMsg.content;
			assistantMsg.status = '';
		} finally {
			chatLoading = false;
		}
	}

	// ============ Hands-free wake listening ============
	/**
	 * Hold the mic open and start recording when the user begins talking.
	 *
	 * Uses its own AudioContext and analyser so that starting/stopping a
	 * recording (which tears down the waveform context) never disturbs the
	 * always-on listener. The underlying MediaStream is shared with the
	 * recorder, so enabling this prompts for mic permission exactly once.
	 */
	async function armHandsFree(): Promise<boolean> {
		if (wakeStream) return true;
		handsFreeArming = true;
		try {
			wakeStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
			});
			wakeContext = new AudioContext();
			const source = wakeContext.createMediaStreamSource(wakeStream);
			wakeAnalyser = wakeContext.createAnalyser();
			wakeAnalyser.fftSize = 512;
			source.connect(wakeAnalyser);
			watchForSpeech();
			return true;
		} catch {
			disarmHandsFree();
			handsFree = false;
			return false;
		} finally {
			handsFreeArming = false;
		}
	}

	function disarmHandsFree() {
		if (wakeFrame) {
			cancelAnimationFrame(wakeFrame);
			wakeFrame = null;
		}
		wakeAnalyser = null;
		if (wakeContext) {
			wakeContext.close();
			wakeContext = null;
		}
		if (wakeStream) {
			wakeStream.getTracks().forEach((t) => t.stop());
			wakeStream = null;
		}
	}

	function watchForSpeech() {
		if (!wakeAnalyser) return;

		const samples = new Uint8Array(wakeAnalyser.fftSize);
		let floor = 0;
		let floorFrames = 0;
		let loudSince: number | null = null;

		const tick = () => {
			if (!wakeAnalyser || !handsFree) return;
			wakeFrame = requestAnimationFrame(tick);

			// Don't listen to ourselves, and don't interrupt an in-flight turn.
			const busy = isRecording || isSpeaking || chatLoading || isTranscribing;
			if (busy || performance.now() < wakeCooldownUntil) {
				loudSince = null;
				return;
			}

			wakeAnalyser.getByteTimeDomainData(samples);
			let sum = 0;
			for (let i = 0; i < samples.length; i++) {
				const v = (samples[i] - 128) / 128;
				sum += v * v;
			}
			const level = Math.sqrt(sum / samples.length);

			// Track the room's quiet baseline continuously rather than once, so
			// drifting background noise (HVAC, a projector fan) doesn't
			// gradually turn into a false trigger.
			if (floorFrames < 240 || level < floor * 1.5) {
				floor = (floor * floorFrames + level) / (floorFrames + 1);
				floorFrames = Math.min(floorFrames + 1, 240);
			}

			const threshold = Math.min(Math.max(floor * 4, 0.03), 0.1);

			if (level > threshold) {
				loudSince ??= performance.now();
				if (performance.now() - loudSince >= WAKE_SUSTAIN_MS) {
					loudSince = null;
					startRecording();
				}
			} else {
				loudSince = null;
			}
		};

		tick();
	}

	async function toggleHandsFree() {
		if (handsFree) {
			handsFree = false;
			disarmHandsFree();
			return;
		}
		handsFree = true;
		const ok = await armHandsFree();
		if (!ok) handsFree = false;
	}

	// ============ Recording ============
	/**
	 * Watch the mic level and end the turn on a natural pause.
	 *
	 * Rooms differ, so rather than hard-coding a threshold we measure the
	 * ambient floor for the first moment of the recording and trigger on a
	 * multiple of it. Silence only counts once we have actually heard speech,
	 * otherwise we would cut off before the user starts talking.
	 */
	function monitorSilence() {
		if (!analyser) return;

		const samples = new Uint8Array(analyser.fftSize);
		const startedAt = performance.now();
		let noiseFloor = 0;
		let calibrationFrames = 0;
		let silenceSince: number | null = null;

		const tick = () => {
			if (!analyser || !isRecording) return;
			vadFrame = requestAnimationFrame(tick);

			analyser.getByteTimeDomainData(samples);

			// RMS deviation from the 128 midpoint = how loud the input is.
			let sum = 0;
			for (let i = 0; i < samples.length; i++) {
				const v = (samples[i] - 128) / 128;
				sum += v * v;
			}
			const level = Math.sqrt(sum / samples.length);
			const elapsed = performance.now() - startedAt;

			// First ~400ms establishes the room's baseline.
			if (elapsed < 400) {
				noiseFloor = (noiseFloor * calibrationFrames + level) / (calibrationFrames + 1);
				calibrationFrames++;
				return;
			}

			// Cap the floor: if the user started talking during calibration we
			// would otherwise measure their voice as "ambient" and set a
			// threshold so high that nothing ever registers as speech.
			const threshold = Math.min(Math.max(noiseFloor * 3, 0.02), 0.09);

			if (level > threshold) {
				heardSpeech = true;
				silenceSince = null;
			} else if (heardSpeech) {
				silenceSince ??= performance.now();
				if (performance.now() - silenceSince >= SILENCE_MS) {
					stopRecording();
					return;
				}
			}

			// Bail out if they never spoke, and hard-cap total length.
			if (!heardSpeech && elapsed > NO_SPEECH_TIMEOUT_MS) {
				cancelRecording();
				return;
			}
			if (elapsed > MAX_RECORDING_MS) {
				stopRecording();
			}
		};

		tick();
	}

	async function startRecording() {
		if (isRecording) return;
		try {
			// Don't record the assistant talking back to us.
			stopSpeaking();

			// In hands-free mode the wake listener already owns a live stream;
			// reuse it so we neither re-prompt for permission nor cut the
			// listener off when this recording ends.
			const ownsStream = !wakeStream;
			const stream =
				wakeStream ??
				(await navigator.mediaDevices.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true
					}
				}));

			// Set up live audio analysis
			audioContext = new AudioContext();
			const source = audioContext.createMediaStreamSource(stream);
			analyser = audioContext.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.7;
			source.connect(analyser);

			mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
			audioChunks = [];
			discardTake = false;

			mediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) audioChunks.push(event.data);
			};

			mediaRecorder.onstop = async () => {
				// Only tear the stream down if this recording opened it.
				if (ownsStream) stream.getTracks().forEach((t) => t.stop());
				stopWaveform();
				// Let the tail of the utterance die down before the wake
				// listener is allowed to trigger again.
				wakeCooldownUntil = performance.now() + WAKE_COOLDOWN_MS;
				// A silent take has nothing worth sending to the transcriber.
				if (discardTake) {
					audioChunks = [];
					return;
				}
				await processRecording();
				wakeCooldownUntil = performance.now() + WAKE_COOLDOWN_MS;
			};

			mediaRecorder.start();
			isRecording = true;
			heardSpeech = false;
			await tick();
			drawWaveform();
			// Hands-free has no click to end a turn, so silence detection is
			// mandatory there regardless of the toggle.
			if (autoStop || handsFree) monitorSilence();
		} catch {
			stopWaveform();
		}
	}

	function stopRecording() {
		if (mediaRecorder && isRecording) {
			isRecording = false;
			mediaRecorder.stop();
		}
	}

	/** Discard the take without transcribing it. */
	function cancelRecording() {
		if (mediaRecorder && isRecording) {
			discardTake = true;
			isRecording = false;
			mediaRecorder.stop();
		}
	}

	async function processRecording() {
		if (audioChunks.length === 0) return;

		isTranscribing = true;
		const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
		const formData = new FormData();
		formData.append('audio', audioBlob, 'recording.webm');

		try {
			const response = await fetch('/api/speech-to-text', { method: 'POST', body: formData });
			const data = await response.json();
			if (data.text) await sendMessage(data.text);
		} catch {
			/* silent */
		} finally {
			isTranscribing = false;
		}
	}

	// ============ Speech synthesis ============
	// Bumped on every new or cancelled utterance so an in-flight chunk queue
	// knows it has been superseded and should drop its remaining clips.
	let speakToken = 0;

	function stopSpeaking() {
		speakToken++;
		window.speechSynthesis.cancel();
		if (currentAudio) {
			currentAudio.pause();
			currentAudio = null;
		}
		isSpeaking = false;
		speakingIndex = -1;
	}

	function cleanForSpeech(text: string): string {
		return text
			.replace(/```[\s\S]*?```/g, '')
			.replace(/[#*_`|>]/g, '')
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			.replace(/\n+/g, '. ')
			.replace(/\s+/g, ' ')
			.slice(0, 3000);
	}

	/** Browser speech synthesis — the always-available fallback. */
	function speakWithBrowser(cleaned: string, index: number) {
		const utterance = new SpeechSynthesisUtterance(cleaned);
		utterance.rate = 1.05;
		utterance.pitch = 1.0;

		const voices = window.speechSynthesis.getVoices();
		const preferred =
			voices.find((v) => v.name.includes('Samantha')) ||
			voices.find((v) => v.name.includes('Karen')) ||
			voices.find((v) => v.name.includes('Google US English')) ||
			voices.find((v) => v.lang.startsWith('en') && v.localService);
		if (preferred) utterance.voice = preferred;

		utterance.onend = () => {
			isSpeaking = false;
			speakingIndex = -1;
		};
		utterance.onerror = () => {
			isSpeaking = false;
			speakingIndex = -1;
		};

		isSpeaking = true;
		speakingIndex = index;
		window.speechSynthesis.speak(utterance);
	}

	/**
	 * Try Kokoro on SPCS first; fall back to browser speech if the service is
	 * cold, suspended, or errors. The app always speaks — quality just improves
	 * when Kokoro is warm.
	 */
	async function speakText(text: string, index: number) {
		if (isSpeaking) {
			const wasSame = speakingIndex === index;
			stopSpeaking();
			if (wasSame) return;
		}

		const cleaned = cleanForSpeech(text);
		if (!cleaned.trim()) return;

		// Status is cached, and the service may have come up (or gone down)
		// since the last check. Re-verify rather than trusting stale state.
		if (ttsState !== 'READY') {
			await refreshTtsStatus();
		}

		if (ttsState !== 'READY') {
			speakWithBrowser(cleaned, index);
			return;
		}

		isSpeaking = true;
		speakingIndex = index;

		// Synthesis time scales with text length, and neither Vite nor
		// adapter-node reliably forwards the upstream stream chunk-by-chunk. So
		// instead of waiting on one big clip, split into sentence groups: the
		// first is short enough to generate fast, and each later group is
		// fetched while the previous one plays.
		const chunks = splitForSpeech(cleaned);
		const token = ++speakToken;

		try {
			let pending = fetchSpeech(chunks[0]);

			for (let i = 0; i < chunks.length; i++) {
				const url = await pending;

				// stopSpeaking() or a newer request superseded this one.
				if (token !== speakToken) {
					URL.revokeObjectURL(url);
					return;
				}

				// Kick off the next chunk now so it generates during playback.
				pending = i + 1 < chunks.length ? fetchSpeech(chunks[i + 1]) : Promise.resolve('');

				await playClip(url, token);
				if (token !== speakToken) return;
			}

			isSpeaking = false;
			speakingIndex = -1;
			currentAudio = null;
		} catch {
			if (token !== speakToken) return;
			isSpeaking = false;
			speakingIndex = -1;
			currentAudio = null;
			refreshTtsStatus();
			speakWithBrowser(cleaned, index);
		}
	}

	/**
	 * Group sentences into chunks. The first is deliberately small so audio
	 * starts quickly; later ones are larger to keep the prosody natural and
	 * avoid a request per sentence.
	 */
	function splitForSpeech(text: string): string[] {
		const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
		const chunks: string[] = [];
		let buf = '';

		for (const sentence of sentences) {
			buf += sentence;
			const limit = chunks.length === 0 ? 90 : 260;
			if (buf.length >= limit) {
				chunks.push(buf.trim());
				buf = '';
			}
		}
		if (buf.trim()) chunks.push(buf.trim());
		return chunks.length ? chunks : [text];
	}

	/** Fetch one chunk as an object URL. Throws so the caller can fall back. */
	async function fetchSpeech(text: string): Promise<string> {
		const res = await fetch('/api/text-to-speech', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text })
		});
		if (!res.ok) throw new Error(`TTS ${res.status}`);
		return URL.createObjectURL(await res.blob());
	}

	/** Play one clip to completion, resolving on end or error. */
	function playClip(url: string, token: number): Promise<void> {
		return new Promise((resolve) => {
			const audio = new Audio(url);
			currentAudio = audio;

			const done = () => {
				URL.revokeObjectURL(url);
				resolve();
			};
			audio.onended = done;
			audio.onerror = done;

			audio.play().catch(done);

			// If stopSpeaking() ran while we were setting up, honour it.
			if (token !== speakToken) {
				audio.pause();
				done();
			}
		});
	}

	// ============ TTS service lifecycle ============
	async function refreshTtsStatus() {
		try {
			const res = await fetch('/api/tts-status');
			const data = await res.json();
			ttsState = data.state;
			ttsDetail = data.detail || '';

			// Stop polling once we reach a settled state.
			if ((ttsState === 'READY' || ttsState === 'UNAVAILABLE') && statusPoll) {
				clearInterval(statusPoll);
				statusPoll = null;
				ttsBusy = false;
			}
		} catch {
			ttsState = 'UNAVAILABLE';
		}
	}

	async function toggleTtsService() {
		const action = ttsState === 'SUSPENDED' ? 'resume' : 'suspend';
		ttsBusy = true;

		try {
			const res = await fetch('/api/tts-status', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action })
			});
			const data = await res.json();
			ttsState = data.state ?? ttsState;
			ttsDetail = data.detail ?? '';

			if (action === 'resume') {
				// Cold start is several minutes; poll until ready.
				if (statusPoll) clearInterval(statusPoll);
				statusPoll = setInterval(refreshTtsStatus, 10000);
			} else {
				ttsBusy = false;
			}
		} catch {
			ttsBusy = false;
		}
	}

	function handleOrbClick() {
		if (isSpeaking) {
			stopSpeaking();
		} else if (isRecording) {
			stopRecording();
		} else if (!chatLoading && !isTranscribing) {
			startRecording();
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			sendMessage();
		}
	}
</script>

<svelte:head>
	<title>Voice Agent — Retail Analytics</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link
		href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div class="app-container">
	<!-- LEFT: Conversation -->
	<div class="conversation-pane">
		<header class="app-header">
			<div class="logo-mark">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
					<path
						d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
						stroke="#fff"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</div>
			<div class="header-text">
				<h1>Voice Agent</h1>
				<div class="subtitle">Retail Analytics &middot; 600M Records</div>
			</div>
			<div class="header-status">
				<span class="status-dot"></span>
				Cortex Agent
			</div>
		</header>

		<div class="chat-area" bind:this={chatArea} onscroll={handleChatScroll}>
			{#if messages.length === 0}
				<div class="welcome">
					<h2>Talk to your data</h2>
					<p>
						Ask anything about retail sales, products, customers, or dealers. Speak or type &mdash;
						answers come back with charts, tables, and voice.
					</p>
					<div class="chips">
						<button class="chip" onclick={() => sendMessage('What is total revenue by region?')}>
							Revenue by region
						</button>
						<button class="chip" onclick={() => sendMessage('What are the top product categories by revenue?')}>
							Top categories
						</button>
						<button class="chip" onclick={() => sendMessage('Show me monthly revenue trends')}>
							Monthly trends
						</button>
					</div>
				</div>
			{/if}

			{#each messages as msg, i}
				<div class="message {msg.role}" class:speaking={speakingIndex === i}>
					<div class="message-label">{msg.role === 'user' ? 'You' : 'Agent'}</div>

					{#if msg.role === 'user'}
						<div class="bubble">{msg.content}</div>
					{:else}
						<div class="bubble">
							{#if msg.status}
								<div class="status-indicator">
									<span class="spinner"></span>
									{msg.status}
								</div>
							{/if}

							{#if msg.html}
								{@html msg.html}
							{/if}

							{#if msg.charts.length > 0}
								{#each msg.charts as chart}
									<div class="vega-chart" data-spec={chart.chart_spec}></div>
								{/each}
							{/if}

							{#if msg.tables.length > 0}
								{#each msg.tables as table}
									<table class="result-table">
										<thead>
											<tr>
												{#each table.result_set.resultSetMetaData.rowType as col}
													<th>{col.name}</th>
												{/each}
											</tr>
										</thead>
										<tbody>
											{#each table.result_set.data as row}
												<tr>
													{#each row as cell}
														<td>{cell ?? ''}</td>
													{/each}
												</tr>
											{/each}
										</tbody>
									</table>
								{/each}
							{/if}

							{#if msg.suggestedQueries.length > 0}
								<div class="chips">
									{#each msg.suggestedQueries as q}
										<button class="chip" onclick={() => sendMessage(q)}>{q}</button>
									{/each}
								</div>
							{/if}
						</div>

						{#if msg.content && !msg.status}
							<button
								class="btn-speak"
								class:active={speakingIndex === i}
								onclick={() => speakText(msg.content, i)}
							>
								{speakingIndex === i ? '\u23F9 Stop' : '\u{1F50A} Listen'}
							</button>
						{/if}
					{/if}
				</div>
			{/each}
		</div>

		{#if !pinnedToBottom && messages.length > 0}
			<button class="jump-latest" onclick={() => scrollToBottom(true)}>
				{'\u2193'} Jump to latest
			</button>
		{/if}
	</div>

	<!-- RIGHT: Voice orb -->
	<div class="voice-pane">
		<div class="orb-wrap" class:active={orbState !== 'idle'}>
			<div class="orb-ring r1"></div>
			<div class="orb-ring r2"></div>
			<div class="orb-ring r3"></div>

			<canvas class="waveform" bind:this={waveCanvas}></canvas>

			<button
				class="orb-core {orbState}"
				onclick={handleOrbClick}
				title={isRecording ? 'Stop and send' : isSpeaking ? 'Stop playback' : 'Start recording'}
			>
				{#if isSpeaking}
					<div class="voice-bars">
						<span></span><span></span><span></span><span></span><span></span><span></span><span></span>
					</div>
				{:else}
					<span class="orb-icon">{orbIcon}</span>
				{/if}
			</button>
		</div>

		<div class="voice-status">
			<div class="label">{statusLabel}</div>
			<div class="hint">{statusHint}</div>
			<label class="auto-stop" title="End the turn automatically on a pause">
				<input type="checkbox" bind:checked={autoStop} disabled={isRecording || handsFree} />
				<span>Auto-stop on silence</span>
			</label>
			<label class="auto-stop" title="Keep the mic open and start recording when you speak">
				<input
					type="checkbox"
					checked={handsFree}
					disabled={handsFreeArming || isRecording}
					onchange={toggleHandsFree}
				/>
				<span>{handsFreeArming ? 'Enabling\u2026' : 'Hands-free'}</span>
			</label>
		</div>

		<div class="input-row">
			<textarea
				bind:value={inputMessage}
				onkeydown={handleKeydown}
				placeholder="Or type a question..."
				disabled={chatLoading || isRecording || isTranscribing}
				rows="2"
			></textarea>
			<button class="btn-send" onclick={() => sendMessage()} disabled={chatLoading || !inputMessage.trim()}>
				Send
			</button>
		</div>

		<button class="autospeak" onclick={() => (autoSpeak = !autoSpeak)}>
			<span class="toggle" class:on={autoSpeak}></span>
			Auto-speak responses
		</button>

		<div class="tts-panel">
			<div class="tts-row">
				<span class="engine-badge" class:live={ttsState === 'READY'}>
					{ttsState === 'READY' ? 'Kokoro on SPCS' : 'Browser voice'}
				</span>
				<button
					class="btn-tts"
					onclick={toggleTtsService}
					disabled={ttsBusy || ttsState === 'UNAVAILABLE'}
				>
					{#if ttsBusy}
						Starting...
					{:else if ttsState === 'SUSPENDED'}
						Warm up
					{:else if ttsState === 'READY'}
						Shut down
					{:else}
						{ttsState}
					{/if}
				</button>
			</div>
			{#if ttsDetail}
				<div class="tts-detail">
					{ttsDetail}{ttsBusy ? ' — cold start takes a few minutes' : ''}
				</div>
			{/if}
		</div>
	</div>
</div>
