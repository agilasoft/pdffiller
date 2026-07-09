# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from openai import OpenAI

from pdffiller.utils.ai_providers.base import ProviderResponse


class OpenAIProvider:
	def __init__(self, api_key, model, azure_endpoint=None, azure_deployment=None):
		if azure_endpoint:
			self.client = OpenAI(api_key=api_key, base_url=azure_endpoint.rstrip("/") + "/openai/v1")
			self.model = azure_deployment or model
		else:
			self.client = OpenAI(api_key=api_key)
			self.model = model

	def chat(self, messages):
		response = self.client.chat.completions.create(
			model=self.model,
			messages=messages,
		)
		choice = response.choices[0]
		message = choice.message

		usage = None
		if response.usage:
			usage = {
				"prompt_tokens": response.usage.prompt_tokens,
				"completion_tokens": response.usage.completion_tokens,
				"total_tokens": response.usage.total_tokens,
			}

		return ProviderResponse(content=message.content, token_usage=usage)
