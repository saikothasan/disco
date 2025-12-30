import {
	WorkflowEntrypoint,
	WorkflowEvent,
	WorkflowStep,
} from "cloudflare:workers";

// -----------------------------------------------------------------------------
// Type Definitions
// -----------------------------------------------------------------------------

export interface Env {
	AI: Ai;
	PROMPT_WORKFLOW: Workflow;
}

// Input payload expected from the user
type WorkflowInput = {
	prompt: string;
	targetModel?: string; // e.g., "GPT-4", "Llama 3"
	tone?: "professional" | "creative" | "academic" | "concise";
};

// Step 1 Output: Analysis of the input
type AnalysisResult = {
	intent: string;
	strengths: string[];
	weaknesses: string[];
	missing_context: boolean;
};

// Step 2 Output: Selected Strategy
type StrategyResult = {
	technique: "CO-STAR" | "Chain-of-Thought" | "Role-Prompting" | "Few-Shot";
	reasoning: string;
	suggested_role: string;
};

// Final Output
type FinalResult = {
	original: string;
	enhanced_prompt: string;
	technique_used: string;
	changelog: string;
};

// -----------------------------------------------------------------------------
// Workflow Implementation
// -----------------------------------------------------------------------------

export class PromptEnhancementWorkflow extends WorkflowEntrypoint<Env, WorkflowInput> {
	async run(event: WorkflowEvent<WorkflowInput>, step: WorkflowStep) {
		const { prompt, tone = "professional", targetModel = "General LLM" } = event.payload;
		const modelId = "@cf/meta/llama-3-8b-instruct"; // Using Llama 3 for instruction following

		// -------------------------------------------------------------------------
		// Step 1: Analyze the User's Prompt
		// -------------------------------------------------------------------------
		const analysis = await step.do("analyze-prompt", async () => {
			const systemMsg = `You are a senior Prompt Engineer. Analyze the user's prompt. 
            Identify the core intent, strengths, and specific weaknesses (ambiguity, lack of context). 
            Output valid JSON only.`;

			const userMsg = `Prompt: "${prompt}"`;

			const response = await this.env.AI.run(modelId, {
				messages: [
					{ role: "system", content: systemMsg },
					{ role: "user", content: userMsg },
				],
				response_format: {
					type: "json_schema",
					json_schema: {
						type: "object",
						properties: {
							intent: { type: "string" },
							strengths: { type: "array", items: { type: "string" } },
							weaknesses: { type: "array", items: { type: "string" } },
							missing_context: { type: "boolean" },
						},
						required: ["intent", "strengths", "weaknesses", "missing_context"],
					},
				},
			});

			// @ts-ignore - Cloudflare AI types might not strictly infer JSON output yet
			return JSON.parse(response.response as string) as AnalysisResult;
		});

		// -------------------------------------------------------------------------
		// Step 2: Determine Optimization Strategy
		// -------------------------------------------------------------------------
		const strategy = await step.do("select-strategy", async () => {
			const systemMsg = `Based on the prompt analysis, select the best prompting technique.
            Options: CO-STAR (Context, Objective, Style, Tone, Audience, Response), Chain-of-Thought, Role-Prompting, Few-Shot.
            Output valid JSON only.`;

			const userMsg = `Analysis: ${JSON.stringify(analysis)}`;

			const response = await this.env.AI.run(modelId, {
				messages: [
					{ role: "system", content: systemMsg },
					{ role: "user", content: userMsg },
				],
				response_format: {
					type: "json_schema",
					json_schema: {
						type: "object",
						properties: {
							technique: { type: "string" },
							reasoning: { type: "string" },
							suggested_role: { type: "string" },
						},
						required: ["technique", "reasoning", "suggested_role"],
					},
				},
			});

			// @ts-ignore
			return JSON.parse(response.response as string) as StrategyResult;
		});

		// -------------------------------------------------------------------------
		// Step 3: Generate Enhanced Prompt
		// -------------------------------------------------------------------------
		const enhancement = await step.do("generate-enhancement", async () => {
			const systemMsg = `You are an expert Prompt Engineer. Rewrite the original prompt using the ${strategy.technique} technique.
            Role: ${strategy.suggested_role}.
            Target Model: ${targetModel}.
            Tone: ${tone}.
            Address these weaknesses: ${analysis.weaknesses.join(", ")}.
            Output valid JSON only.`;

			const userMsg = `Original Prompt: "${prompt}"`;

			const response = await this.env.AI.run(modelId, {
				messages: [
					{ role: "system", content: systemMsg },
					{ role: "user", content: userMsg },
				],
				response_format: {
					type: "json_schema",
					json_schema: {
						type: "object",
						properties: {
							enhanced_prompt: { type: "string" },
							changelog: { type: "string", description: "Brief explanation of changes made" },
						},
						required: ["enhanced_prompt", "changelog"],
					},
				},
			});

			// @ts-ignore
			const result = JSON.parse(response.response as string);
			
			return {
				original: prompt,
				enhanced_prompt: result.enhanced_prompt,
				technique_used: strategy.technique,
				changelog: result.changelog,
			} as FinalResult;
		});

		return enhancement;
	}
}

// -----------------------------------------------------------------------------
// API Entrypoint
// -----------------------------------------------------------------------------

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		// POST /start - Trigger the workflow
		if (req.method === "POST" && url.pathname === "/enhance") {
			const payload = await req.json<WorkflowInput>();
			
			// Validate payload
			if (!payload.prompt) {
				return Response.json({ error: "Missing 'prompt' in body" }, { status: 400 });
			}

			const instance = await env.PROMPT_WORKFLOW.create({
				id: crypto.randomUUID(), // Unique ID for this run
				params: payload,
			});

			return Response.json({
				status: "started",
				id: instance.id,
				monitor_url: `/status?id=${instance.id}`,
			});
		}

		// GET /status?id=... - Check status
		if (req.method === "GET" && url.pathname === "/status") {
			const id = url.searchParams.get("id");
			if (!id) return Response.json({ error: "Missing 'id'" }, { status: 400 });

			try {
				const instance = await env.PROMPT_WORKFLOW.get(id);
				const status = await instance.status();
				return Response.json(status);
			} catch (e) {
				return Response.json({ error: "Instance not found" }, { status: 404 });
			}
		}

		return new Response("Not Found", { status: 404 });
	},
};
