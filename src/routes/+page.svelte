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

	// Voice state
	let isRecording = $state(false);
	let isTranscribing = $state(false);
	let mediaRecorder: MediaRecorder | null = null;
	let audioChunks: Blob[] = [];

	let chatArea: HTMLDivElement;
	let vegaEmbedModule: typeof import('vega-embed') | null = null;

	onMount(async () => {
		vegaEmbedModule = await import('vega-embed');
		const mermaidMod = await import('mermaid');
		mermaidMod.default.initialize({ startOnLoad: false, theme: 'neutral' });
	});

	function scrollToBottom() {
		if (chatArea) {
			chatArea.scrollTop = chatArea.scrollHeight;
		}
	}

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
				// leave original text if mermaid can't render
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
				await vegaEmbedModule.default(el as HTMLElement, spec, {
					actions: false,
					renderer: 'svg'
				});
				el.setAttribute('data-rendered', 'true');
			} catch {
				el.textContent = 'Failed to render chart';
			}
		}
	}

	async function sendMessage(text?: string) {
		const msg = text || inputMessage.trim();
		if (!msg || chatLoading) return;

		inputMessage = '';
		chatLoading = true;

		// Add user message
		messages = [
			...messages,
			{ role: 'user', content: msg, html: '', status: '', charts: [], tables: [], suggestedQueries: [] }
		];

		// Add assistant placeholder and grab the proxy ref
		messages = [
			...messages,
			{ role: 'assistant', content: '', html: '', status: 'Connecting...', charts: [], tables: [], suggestedQueries: [] }
		];
		const assistantMsg = messages[messages.length - 1];

		await tick();
		scrollToBottom();

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

							// Status events
							if (data.status === 'planning') assistantMsg.status = 'Planning...';
							if (data.status === 'executing_tool')
								assistantMsg.status = `Running ${data.tool_type || 'tool'}...`;
							if (data.status === 'proceeding_to_answer')
								assistantMsg.status = 'Generating response...';

							// Text deltas
							if (currentEvent === 'response.text.delta' && data.text) {
								collectedText += data.text;
								assistantMsg.content = collectedText;
								assistantMsg.html = await marked.parse(collectedText);
								assistantMsg.status = '';
								await tick();
								scrollToBottom();
							}

							// Chart events
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

							// Table events
							if (currentEvent === 'response.table' && data.result_set) {
								const key = data.tool_use_id || JSON.stringify(data.result_set.data?.[0]);
								if (!seenTableIds.has(key)) {
									seenTableIds.add(key);
									assistantMsg.tables = [
										...assistantMsg.tables,
										{
											title: data.title,
											tool_use_id: data.tool_use_id,
											result_set: data.result_set
										}
									];
								}
							}

							// Final assembled response
							if (currentEvent === 'response' && data.content) {
								let lastText = '';
								for (const item of data.content) {
									if (item.type === 'text' && item.text?.trim()) {
										lastText = item.text;
									}
									if (item.type === 'chart' && item.chart?.chart_spec) {
										const key = item.chart.tool_use_id || item.chart.chart_spec;
										if (!seenChartIds.has(key)) {
											seenChartIds.add(key);
											assistantMsg.charts = [
												...assistantMsg.charts,
												{
													tool_use_id: item.chart.tool_use_id,
													chart_spec: item.chart.chart_spec
												}
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
							// partial JSON — ignore
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
			scrollToBottom();
		} catch (err) {
			assistantMsg.content = `Error: ${err instanceof Error ? err.message : 'Network error'}`;
			assistantMsg.html = assistantMsg.content;
			assistantMsg.status = '';
		} finally {
			chatLoading = false;
		}
	}

	// Voice recording
	async function startRecording() {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
			audioChunks = [];

			mediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) audioChunks.push(event.data);
			};

			mediaRecorder.onstop = async () => {
				stream.getTracks().forEach((track) => track.stop());
				await processRecording();
			};

			mediaRecorder.start();
			isRecording = true;
		} catch {
			// mic permission denied or unavailable
		}
	}

	function stopRecording() {
		if (mediaRecorder && isRecording) {
			mediaRecorder.stop();
			isRecording = false;
		}
	}

	async function processRecording() {
		if (audioChunks.length === 0) return;

		isTranscribing = true;
		const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
		const formData = new FormData();
		formData.append('audio', audioBlob, 'recording.webm');

		try {
			const response = await fetch('/api/speech-to-text', {
				method: 'POST',
				body: formData
			});

			const data = await response.json();
			if (data.text) {
				await sendMessage(data.text);
			}
		} catch {
			// transcription failed silently
		} finally {
			isTranscribing = false;
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
	<title>Voice Agent Demo</title>
</svelte:head>

<div class="app-container">
	<header class="app-header">
		<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
			<path
				d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
				stroke="#29B5E8"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
		<h1>Voice Agent Demo</h1>
		<span class="badge">Retail Analytics</span>
	</header>

	<div class="chat-area" bind:this={chatArea}>
		{#if messages.length === 0}
			<div class="welcome">
				<h2>Talk to your data</h2>
				<p>Ask questions by typing or recording your voice. Powered by Snowflake Cortex Agent and ElevenLabs Scribe.</p>
				<div class="suggested-queries">
					<button onclick={() => sendMessage('What are the top 10 products by revenue?')}>Top products by revenue</button>
					<button onclick={() => sendMessage('Show me monthly sales trends')}>Monthly sales trends</button>
					<button onclick={() => sendMessage('Which dealers have the highest volume?')}>Top dealers by volume</button>
				</div>
			</div>
		{/if}

		{#each messages as msg}
			<div class="message {msg.role}">
				{#if msg.status}
					<div class="status-indicator">{msg.status}</div>
				{/if}

				{#if msg.role === 'user'}
					{msg.content}
				{:else}
					<div class="message-content">
						{@html msg.html}
					</div>

					{#if msg.charts.length > 0}
						{#each msg.charts as chart}
							<div class="vega-chart" data-spec={chart.chart_spec}></div>
						{/each}
					{/if}

					{#if msg.tables.length > 0}
						{#each msg.tables as table}
							{#if table.title}
								<strong>{table.title}</strong>
							{/if}
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
						<div class="suggested-queries">
							{#each msg.suggestedQueries as q}
								<button onclick={() => sendMessage(q)}>{q}</button>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		{/each}
	</div>

	<div class="input-area">
		<button
			class="btn btn-mic"
			class:recording={isRecording}
			onclick={isRecording ? stopRecording : startRecording}
			disabled={chatLoading || isTranscribing}
			title={isRecording ? 'Stop recording' : 'Record voice message'}
		>
			{#if isTranscribing}
				&#8987;
			{:else if isRecording}
				&#9632;
			{:else}
				&#127908;
			{/if}
		</button>
		<textarea
			bind:value={inputMessage}
			onkeydown={handleKeydown}
			placeholder={isRecording ? 'Recording...' : isTranscribing ? 'Transcribing...' : 'Ask a question...'}
			disabled={chatLoading || isRecording || isTranscribing}
			rows="1"
		></textarea>
		<button class="btn btn-send" onclick={() => sendMessage()} disabled={chatLoading || !inputMessage.trim()}>
			Send
		</button>
	</div>
</div>
