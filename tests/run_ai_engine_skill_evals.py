#!/usr/bin/env python3

"""Validate the frozen AI Engine and platform-plugin policy scenario matrix."""

from pathlib import Path
import sys
import yaml


ROOT = Path(__file__).resolve().parents[1]
FILES = [
    ROOT / "rainbond-platform-plugin-manager" / "evals" / "scenarios.yaml",
    ROOT / "rainbond-ai-assistant" / "evals" / "scenarios.yaml",
]
REQUIRED_IDS = {
    "already_running", "installed_state_unavailable", "install_then_poll", "upgrade_existing",
    "uninstall_existing", "resume_ai_intent", "modelscope_normalization", "reject_unsupported_sources",
    "download_idempotent", "download_job_gone_model_ready", "download_bytes_not_terminal",
    "cpu_only_deploy", "cpu_resource_invalid", "cpu_memory_preflight", "cpu_gpu_params_rejected",
    "standard_gpu_whole", "hami_shared", "hami_whole_fallback", "provider_conflict",
    "usage_unavailable", "pod_running_registration_missing", "stopped_terminal",
    "legacy_history_fallback", "mutation_unknown", "throughput_experiment",
    "generic_latency_requires_classification", "queued_with_gpu_headroom",
    "empty_queue_slow_decode", "repeated_prefix_cache_candidate",
    "no_prefix_reuse_no_cache_claim", "long_prompt_prefill_contention",
    "chunked_prefill_support_unknown", "long_context_coupled_capacity",
    "fp8_kv_cache_quality_gate", "tensor_parallel_for_fit",
    "pipeline_parallel_not_default", "explicit_kv_cache_conflict",
    "hami_utilization_uses_slice", "cpu_offload_is_fit_only",
    "quality_priority_avoids_aggressive_quantization",
    "new_multimodal_deploy_requires_startup_safety", "ai_context_resolve_exact_contract",
    "model_download_identifier_translation", "model_download_optional_display_name_guard",
    "cost_goal_keeps_slo_and_quality_constraints",
    "unstable_baseline_reduces_aggressive_settings",
    "multimodal_requires_bounded_inputs", "stream_interval",
    "delete_order",
    "plugin_progress_mode_required", "plugin_deferred_monitoring",
    "modelscope_openapi_fallback", "ai_long_task_progress_mode_required", "ai_deferred_resume",
    "gpu_no_hardware", "gpu_standard_pending", "gpu_monitoring_unavailable",
    "gpu_driver_missing_verified",
}


def main() -> int:
    cases = []
    for path in FILES:
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert isinstance(payload, dict) and isinstance(payload.get("cases"), list), path
        cases.extend(payload["cases"])
    ids = [case.get("id") for case in cases]
    assert len(ids) == len(set(ids)), "duplicate eval ids"
    assert REQUIRED_IDS <= set(ids), f"missing evals: {sorted(REQUIRED_IDS - set(ids))}"
    for case in cases:
        assert isinstance(case.get("facts"), dict) and case["facts"], case["id"]
        assert isinstance(case.get("expected"), dict) and case["expected"], case["id"]
    print(f"PASS: {len(cases)} AI Engine policy evals")
    return 0


if __name__ == "__main__":
    sys.exit(main())
