/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.designer.ai");

(function () {
	"use strict";

	let dialog = null;
	let context = null;
	let chatHistory = [];
	let pendingSuggestions = [];

	function escapeHtml(text) {
		return frappe.utils.escape_html(text || "");
	}

	function getFieldsPayload() {
		if (!context?.getFields) return "[]";
		return JSON.stringify(context.getFields());
	}

	function renderMessages(container) {
		if (!chatHistory.length) {
			container.innerHTML = `<div class="pfd-ai-empty">${__(
				"Ask for mapping help or click Suggest Mappings."
			)}</div>`;
			return;
		}
		container.innerHTML = chatHistory
			.map((row) => {
				const roleClass = row.role === "user" ? "pfd-ai-msg-user" : "pfd-ai-msg-assistant";
				return `<div class="pfd-ai-msg ${roleClass}">
					<div class="pfd-ai-msg-role">${row.role === "user" ? __("You") : __("AI")}</div>
					<div class="pfd-ai-msg-text">${escapeHtml(row.content).replace(/\n/g, "<br>")}</div>
				</div>`;
			})
			.join("");
		container.scrollTop = container.scrollHeight;
	}

	function renderSuggestions(container) {
		if (!pendingSuggestions.length) {
			container.innerHTML = "";
			container.classList.add("hidden");
			return;
		}
		container.classList.remove("hidden");
		container.innerHTML = `
			<div class="pfd-ai-suggestions-header">
				<span>${__("{0} suggestion(s)", [pendingSuggestions.length])}</span>
				<button type="button" class="btn btn-primary btn-xs pfd-ai-apply-all">${__(
					"Apply All"
				)}</button>
			</div>
			<div class="pfd-ai-suggestions-list">
				${pendingSuggestions
					.map(
						(row, index) => `
					<div class="pfd-ai-suggestion" data-index="${index}">
						<div class="pfd-ai-suggestion-title">${escapeHtml(row.pdf_field_name)}</div>
						<div class="pfd-ai-suggestion-meta">
							${escapeHtml(row.source_type)} → ${escapeHtml(
								row.source_field || row.jinja_script || ""
							)}
						</div>
						${
							row.reason
								? `<div class="pfd-ai-suggestion-reason">${escapeHtml(row.reason)}</div>`
								: ""
						}
						<button type="button" class="btn btn-default btn-xs pfd-ai-apply-one" data-index="${index}">
							${__("Apply")}
						</button>
					</div>
				`
					)
					.join("")}
			</div>
		`;

		container.querySelector(".pfd-ai-apply-all")?.addEventListener("click", () => {
			context?.applySuggestions?.(pendingSuggestions);
			pendingSuggestions = [];
			renderSuggestions(container);
		});

		container.querySelectorAll(".pfd-ai-apply-one").forEach((btn) => {
			btn.addEventListener("click", () => {
				const index = parseInt(btn.dataset.index, 10);
				const suggestion = pendingSuggestions[index];
				if (!suggestion) return;
				context?.applySuggestions?.([suggestion]);
				pendingSuggestions.splice(index, 1);
				renderSuggestions(container);
			});
		});
	}

	function setSuggestions(suggestions) {
		pendingSuggestions = suggestions || [];
		const container = dialog?.$wrapper?.find(".pfd-ai-suggestions")[0];
		if (container) renderSuggestions(container);
	}

	function pushMessage(role, content) {
		chatHistory.push({ role, content });
		const container = dialog?.$wrapper?.find(".pfd-ai-messages")[0];
		if (container) renderMessages(container);
	}

	function suggestMappings(mode = "unmapped") {
		if (!context?.templateName) return;

		frappe.call({
			method: "pdffiller.api.ai_assist.suggest_mappings",
			args: {
				template: context.templateName,
				fields: getFieldsPayload(),
				mode,
			},
			freeze: true,
			freeze_message: __("Analyzing fields…"),
			callback(r) {
				const data = r.message || {};
				if (data.message) {
					pushMessage("assistant", data.message);
				}
				if (data.suggestions?.length) {
					setSuggestions(data.suggestions);
					pushMessage(
						"assistant",
						__("Found {0} mapping suggestion(s). Review and apply below.", [
							data.suggestions.length,
						])
					);
				} else if (!data.message) {
					pushMessage("assistant", __("No mapping suggestions were found."));
				}
			},
		});
	}

	function sendChat(message) {
		if (!context?.templateName || !message) return;

		pushMessage("user", message);

		frappe.call({
			method: "pdffiller.api.ai_assist.assist_chat",
			args: {
				template: context.templateName,
				message,
				fields: getFieldsPayload(),
				history: JSON.stringify(chatHistory.slice(0, -1)),
			},
			freeze: true,
			freeze_message: __("Thinking…"),
			callback(r) {
				const data = r.message || {};
				if (data.message) {
					pushMessage("assistant", data.message);
				}
				if (data.suggestions?.length) {
					setSuggestions(data.suggestions);
				}
			},
		});
	}

	function openDialog(ctx) {
		context = ctx;
		chatHistory = [];
		pendingSuggestions = [];

		if (dialog) {
			dialog.show();
			const messages = dialog.$wrapper.find(".pfd-ai-messages")[0];
			if (messages) renderMessages(messages);
			const suggestions = dialog.$wrapper.find(".pfd-ai-suggestions")[0];
			if (suggestions) renderSuggestions(suggestions);
			return;
		}

		dialog = new frappe.ui.Dialog({
			title: __("AI Field Assistant"),
			size: "large",
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "ai_panel",
				},
			],
			primary_action_label: __("Close"),
			primary_action() {
				dialog.hide();
			},
		});

		dialog.$wrapper.find(".modal-body").html(`
			<div class="pfd-ai-panel">
				<div class="pfd-ai-actions">
					<button type="button" class="btn btn-default btn-sm pfd-ai-suggest-unmapped">
						${frappe.utils.icon("magic", "xs")}
						${__("Suggest Mappings")}
					</button>
					<button type="button" class="btn btn-default btn-sm pfd-ai-settings" title="${__(
						"Open AI Settings"
					)}">
						${frappe.utils.icon("setting", "xs")}
					</button>
				</div>
				<div class="pfd-ai-messages"></div>
				<div class="pfd-ai-suggestions hidden"></div>
				<div class="pfd-ai-input-row">
					<textarea class="pfd-ai-input" rows="2" placeholder="${__(
						"Ask about field mapping, naming, or Jinja templates…"
					)}"></textarea>
					<button type="button" class="btn btn-primary btn-sm pfd-ai-send">${__("Send")}</button>
				</div>
			</div>
		`);

		const wrapper = dialog.$wrapper;
		wrapper.find(".pfd-ai-suggest-unmapped").on("click", () => suggestMappings("unmapped"));
		wrapper.find(".pfd-ai-settings").on("click", () => {
			frappe.set_route("Form", "PDF Filler AI Settings", "PDF Filler AI Settings");
		});

		const input = wrapper.find(".pfd-ai-input");
		const submit = () => {
			const message = (input.val() || "").trim();
			if (!message) return;
			input.val("");
			sendChat(message);
		};
		wrapper.find(".pfd-ai-send").on("click", submit);
		input.on("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				submit();
			}
		});

		renderMessages(wrapper.find(".pfd-ai-messages")[0]);
		dialog.show();
	}

	pdffiller.designer.ai = {
		isEnabled() {
			return !!(frappe.boot && frappe.boot.pdffiller_ai_enabled);
		},
		refreshStatus(callback) {
			frappe.call({
				method: "pdffiller.api.ai_assist.get_ai_status",
				callback(r) {
					const enabled = !!(r.message && r.message.enabled);
					if (frappe.boot) frappe.boot.pdffiller_ai_enabled = enabled;
					callback?.(enabled);
				},
			});
		},
		open: openDialog,
	};
})();
