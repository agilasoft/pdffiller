# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import anthropic

from pdffiller.utils.ai_providers.base import ProviderResponse


class AnthropicProvider:
	def __init__(self, api_key, model):
		self.client = anthropic.Anthropic(api_key=api_key)
		self.model = model

	def chat(self, messages):
		system = ""
		api_messages = []
		for msg in messages:
			if msg["role"] == "system":
				system = msg.get("content") or ""
				continue
			api_messages.append({"role": msg["role"], "content": msg.get("content") or ""})

		kwargs = {
			"model": self.model,
			"max_tokens": 4096,
			"messages": api_messages,
		}
		if system:
			kwargs["system"] = system

		response = self.client.messages.create(**kwargs)

		text_parts = []
		for block in response.content:
			if block.type == "text":
				text_parts.append(block.text)

		usage = None
		if response.usage:
			usage = {
				"prompt_tokens": response.usage.input_tokens,
				"completion_tokens": response.usage.output_tokens,
				"total_tokens": response.usage.input_tokens + response.usage.output_tokens,
			}

		return ProviderResponse(
			content="\n".join(text_parts) if text_parts else None,
			token_usage=usage,
		)
