# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import frappe


def format_llm_error(exc):
	"""Return a user-safe message for LLM provider failures."""
	message = str(exc)
	exc_name = type(exc).__name__

	if exc_name == "RateLimitError" or "insufficient_quota" in message:
		if "insufficient_quota" in message:
			return (
				"The configured LLM provider has no remaining API quota. "
				"Add billing or switch Provider in **PDF Filler AI Settings**."
			)
		return "The LLM provider rate-limited this request. Please wait a moment and try again."

	if exc_name == "ValidationError":
		if "api key" in message.lower():
			return (
				"The API key in **PDF Filler AI Settings** is missing. "
				"Enter your provider API key, save, and try again."
			)
		if "not configured" in message.lower():
			return message

	if exc_name in ("AuthenticationError", "PermissionDeniedError") or "invalid_api_key" in message:
		return (
			"The API key in **PDF Filler AI Settings** is invalid or expired. "
			"Update the key and save, then try again."
		)

	if "api key is not configured" in message.lower() or "password not found" in message.lower():
		return (
			"The API key in **PDF Filler AI Settings** is missing. "
			"Enter your provider API key, save, and try again."
		)

	if exc_name == "NotFoundError" or "model_not_found" in message:
		return (
			"The model name in **PDF Filler AI Settings** was not found for this provider. "
			"Check the Model field and try again."
		)

	if exc_name == "APIConnectionError":
		return "Could not connect to the LLM provider. Check network access and provider settings."

	if exc_name == "BadRequestError" or "invalid_request_error" in message:
		return (
			"The LLM provider rejected the request. Check **PDF Filler AI Settings** "
			"(provider, model, API key) and try again."
		)

	if "anthropic" in message.lower() and "credit" in message.lower():
		return (
			"Your Anthropic account has insufficient credits. "
			"Add billing or choose another provider in **PDF Filler AI Settings**."
		)

	frappe.log_error(title="PDF Filler AI LLM error", message=frappe.get_traceback())
	return (
		"Sorry, the AI assistant could not complete your request due to a provider error. "
		"Please contact your system administrator if this continues."
	)
