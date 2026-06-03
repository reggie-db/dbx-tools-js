/**
 * Example agent-service ranker. Picks Foundation Model endpoints
 * out of a Databricks `/serving-endpoints` listing using three
 * optional filters:
 *
 *   - `classes`: single string or array of `model_class` values
 *     (`"claude"`, `"gpt-oss"`, `"gemini"`, ...). Case-insensitive.
 *   - `speed`: 0-1 threshold against the candidate pool's
 *     `ai_gateway_model_profile.speed`. Normalized as
 *     `(v - min) / (max - min)`; items >= threshold pass. If
 *     nothing passes, the single highest-speed item wins (so
 *     `0.9` against a pool whose top normalized speed is `0.8`
 *     still returns one result).
 *   - `quality`: same shape as `speed`, against
 *     `ai_gateway_model_profile.quality`.
 *
 * Backend: tests run against an inline `SERVING_ENDPOITNS_JSON`
 * fixture (a snapshot of a real workspace's `/api/2.0/serving-endpoints`
 * response) so the suite is offline / hermetic and doesn't need a
 * Databricks profile. The live `servingEndpoints()` helper lives at
 * `packages/serving/src/models.ts`; switch `getServingEndpoints` over
 * to it when you want to drive these against a real workspace.
 *
 * Run as a test:
 *   ```
 *   bun test packages/serving/test/models.test.ts
 *   ```
 */

import { describe, expect, it } from "bun:test";
import pMemoize from "p-memoize";

import {
  foundationModelProfile,
  type ServingEndpoint,
  foundationModelClass,
  foundationModelVersion,
} from "../src/models";

const SERVING_ENDPOITNS_JSON = `
{
  "endpoints": [
    {
      "name": "guest-promise-time-v2",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1779139587000,
      "last_updated_timestamp": 1780454744000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING",
        "suspend": "NOT_SUSPENDED",
        "system_update_failure": false
      },
      "config": {
        "served_entities": [
          {
            "name": "dev_dsmodel_dev_guest_promise_time_v2-2",
            "entity_name": "reggie_pierce_7405614800873570.inspire_p2s.dev_dsmodel_dev_guest_promise_time_v2",
            "entity_version": "3",
            "type": "UC_MODEL"
          }
        ],
        "served_models": [
          {
            "name": "dev_dsmodel_dev_guest_promise_time_v2-2",
            "model_name": "reggie_pierce_7405614800873570.inspire_p2s.dev_dsmodel_dev_guest_promise_time_v2",
            "model_version": "3",
            "type": "UC_MODEL"
          }
        ]
      },
      "id": "28d5152d0be2477c8c871f1998585b19",
      "route_optimized": false,
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "description": ""
    },
    {
      "name": "lensiq-cigarette-vape",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1779987951000,
      "last_updated_timestamp": 1780003993000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING",
        "suspend": "NOT_SUSPENDED",
        "system_update_failure": false
      },
      "config": {
        "served_entities": [
          {
            "name": "lensiq_cigarette_vape-1",
            "entity_name": "reggie_pierce_7405614800873570.lensiq.lensiq_cigarette_vape",
            "entity_version": "1",
            "type": "UC_MODEL"
          }
        ],
        "served_models": [
          {
            "name": "lensiq_cigarette_vape-1",
            "model_name": "reggie_pierce_7405614800873570.lensiq.lensiq_cigarette_vape",
            "model_version": "1",
            "type": "UC_MODEL"
          }
        ]
      },
      "id": "cf9f57756bd14829b7b356062d7286ee",
      "route_optimized": false,
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "description": ""
    },
    {
      "name": "lensiq-detector",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1779390793000,
      "last_updated_timestamp": 1780005787000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING",
        "suspend": "NOT_SUSPENDED",
        "system_update_failure": false
      },
      "config": {
        "served_entities": [
          {
            "name": "lensiq_detector-1",
            "entity_name": "reggie_pierce_7405614800873570.lensiq.lensiq_detector",
            "entity_version": "1",
            "type": "UC_MODEL"
          }
        ],
        "served_models": [
          {
            "name": "lensiq_detector-1",
            "model_name": "reggie_pierce_7405614800873570.lensiq.lensiq_detector",
            "model_version": "1",
            "type": "UC_MODEL"
          }
        ]
      },
      "id": "299e1df8b61141cbae893c7866e07dc9",
      "route_optimized": false,
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "description": ""
    },
    {
      "name": "lensiq-face-recognition",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1780064645000,
      "last_updated_timestamp": 1780066837000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING",
        "suspend": "NOT_SUSPENDED",
        "system_update_failure": false
      },
      "config": {
        "served_entities": [
          {
            "name": "lensiq_face_recognition-2",
            "entity_name": "reggie_pierce_7405614800873570.lensiq.lensiq_face_recognition",
            "entity_version": "2",
            "type": "UC_MODEL"
          }
        ],
        "served_models": [
          {
            "name": "lensiq_face_recognition-2",
            "model_name": "reggie_pierce_7405614800873570.lensiq.lensiq_face_recognition",
            "model_version": "2",
            "type": "UC_MODEL"
          }
        ]
      },
      "id": "d95d79305bd94384b8b71a42e148acf4",
      "route_optimized": false,
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "description": ""
    },
    {
      "name": "lensiq-fog-detector",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1779987868000,
      "last_updated_timestamp": 1780005637000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING",
        "suspend": "NOT_SUSPENDED",
        "system_update_failure": false
      },
      "config": {
        "served_entities": [
          {
            "name": "lensiq_fog_detector-1",
            "entity_name": "reggie_pierce_7405614800873570.lensiq.lensiq_fog_detector",
            "entity_version": "1",
            "type": "UC_MODEL"
          }
        ],
        "served_models": [
          {
            "name": "lensiq_fog_detector-1",
            "model_name": "reggie_pierce_7405614800873570.lensiq.lensiq_fog_detector",
            "model_version": "1",
            "type": "UC_MODEL"
          }
        ]
      },
      "id": "13aaba50bf12462296896ba078967efc",
      "route_optimized": false,
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "description": ""
    },
    {
      "name": "lensiq-license-plate",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1779987948000,
      "last_updated_timestamp": 1780003739000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING",
        "suspend": "NOT_SUSPENDED",
        "system_update_failure": false
      },
      "config": {
        "served_entities": [
          {
            "name": "lensiq_license_plate-1",
            "entity_name": "reggie_pierce_7405614800873570.lensiq.lensiq_license_plate",
            "entity_version": "1",
            "type": "UC_MODEL"
          }
        ],
        "served_models": [
          {
            "name": "lensiq_license_plate-1",
            "model_name": "reggie_pierce_7405614800873570.lensiq.lensiq_license_plate",
            "model_version": "1",
            "type": "UC_MODEL"
          }
        ]
      },
      "id": "13cd11fdfd6f441c99e25de0d58b14e5",
      "route_optimized": false,
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "description": ""
    },
    {
      "name": "lensiq-slip-fall",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1779987951000,
      "last_updated_timestamp": 1780003989000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING",
        "suspend": "NOT_SUSPENDED",
        "system_update_failure": false
      },
      "config": {
        "served_entities": [
          {
            "name": "lensiq_slip_fall-1",
            "entity_name": "reggie_pierce_7405614800873570.lensiq.lensiq_slip_fall",
            "entity_version": "1",
            "type": "UC_MODEL"
          }
        ],
        "served_models": [
          {
            "name": "lensiq_slip_fall-1",
            "model_name": "reggie_pierce_7405614800873570.lensiq.lensiq_slip_fall",
            "model_version": "1",
            "type": "UC_MODEL"
          }
        ]
      },
      "id": "fce43dc3f5dc47b69cf2b1b5f085c445",
      "route_optimized": false,
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "description": ""
    },
    {
      "name": "lensiq-spill",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1779987949000,
      "last_updated_timestamp": 1780080606000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING",
        "suspend": "NOT_SUSPENDED",
        "system_update_failure": false
      },
      "config": {
        "served_entities": [
          {
            "name": "lensiq_spill-12",
            "entity_name": "reggie_pierce_7405614800873570.lensiq.lensiq_spill",
            "entity_version": "12",
            "type": "UC_MODEL"
          }
        ],
        "served_models": [
          {
            "name": "lensiq_spill-12",
            "model_name": "reggie_pierce_7405614800873570.lensiq.lensiq_spill",
            "model_version": "12",
            "type": "UC_MODEL"
          }
        ]
      },
      "id": "6afd3ca090084fc4a14be4cd91672435",
      "route_optimized": false,
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "description": ""
    },
    {
      "name": "lensiq-wet-floor-sign",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1779987951000,
      "last_updated_timestamp": 1780084540000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING",
        "suspend": "NOT_SUSPENDED",
        "system_update_failure": false
      },
      "config": {
        "served_entities": [
          {
            "name": "lensiq_wet_floor_sign-7",
            "entity_name": "reggie_pierce_7405614800873570.lensiq.lensiq_wet_floor_sign",
            "entity_version": "7",
            "type": "UC_MODEL"
          }
        ],
        "served_models": [
          {
            "name": "lensiq_wet_floor_sign-7",
            "model_name": "reggie_pierce_7405614800873570.lensiq.lensiq_wet_floor_sign",
            "model_version": "7",
            "type": "UC_MODEL"
          }
        ]
      },
      "id": "57c419f875a94719966c3742b8339028",
      "route_optimized": false,
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "description": ""
    },
    {
      "name": "mas-996e9c3d-endpoint",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1779214917000,
      "last_updated_timestamp": 1779214917000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {},
      "id": "9bd4e102071140b79e31b3e3e0abe769",
      "route_optimized": false,
      "task": "agent/v1/responses",
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "tile_endpoint_metadata": {
        "tile_id": "996e9c3d-6a6c-4e63-a626-c0cbee33deb2",
        "tile_model_name": "mas-base-model-16ea9c33",
        "problem_type": "MULTI_AGENT_SUPERVISOR"
      },
      "description": ""
    },
    {
      "name": "mas-a2881a87-endpoint",
      "creator": "reggie.pierce@databricks.com",
      "creation_timestamp": 1780410661000,
      "last_updated_timestamp": 1780410661000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {},
      "id": "b04f2e2f7b5843f291932dcd5fa567dc",
      "route_optimized": false,
      "task": "agent/v1/responses",
      "permission_level": "CAN_MANAGE",
      "creator_display_name": "Reggie Pierce",
      "creator_kind": "User",
      "tile_endpoint_metadata": {
        "tile_id": "a2881a87-c999-425b-a042-232ff80ab914",
        "tile_model_name": "mas-base-model-75cbb22e",
        "problem_type": "MULTI_AGENT_SUPERVISOR"
      },
      "description": ""
    },
    {
      "name": "databricks-claude-opus-4-7",
      "creation_timestamp": 1776297600000,
      "last_updated_timestamp": 1776297600000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-claude-opus-4-7",
            "entity_name": "system.ai.databricks-claude-opus-4-7",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-claude-opus-4-7",
              "display_name": "Claude Opus 4.7",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#claude-opus-4-7",
              "description": "Claude Opus 4.7 is Anthropic's most capable hybrid reasoning model, advancing the Opus series with improved accuracy, efficiency, and enhanced vision capabilities. This model delivers stronger performance on complex extraction and agentic reasoning tasks while using fewer output tokens than its predecessor. Claude Opus 4.7 features a 1 million token context window and increased image resolution support, making it ideal for enterprise applications that require deep analysis, document understanding, and sophisticated multi-step workflows. This model is hosted by Databricks.",
              "price": "357.143",
              "input_price": "71.429",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "claude",
              "api_types": [
                "mlflow/v1/chat/completions",
                "anthropic/v1/messages",
                "cursor/v1/chat/completions"
              ],
              "ai_gateway_model_profile": {
                "speed": 43.7,
                "cost": 10.0,
                "quality": 46.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "openai_reasoning": false,
        "anthropic_reasoning": false,
        "image_input": true,
        "long_context": false,
        "video_input_translation": false,
        "audio_input_translation": false
      }
    },
    {
      "name": "databricks-claude-opus-4-8",
      "creation_timestamp": 1779926400000,
      "last_updated_timestamp": 1779926400000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-claude-opus-4-8",
            "entity_name": "system.ai.databricks-claude-opus-4-8",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-claude-opus-4-8",
              "display_name": "Claude Opus 4.8",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#claude-opus-4-8",
              "description": "Claude Opus 4.8 is Anthropic's next-generation Opus model, hosted by Databricks.",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "claude",
              "api_types": [
                "mlflow/v1/chat/completions",
                "anthropic/v1/messages",
                "cursor/v1/chat/completions"
              ],
              "ai_gateway_model_profile": {
                "speed": 43.7,
                "cost": 10.0,
                "quality": 46.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "openai_reasoning": false,
        "anthropic_reasoning": false,
        "image_input": true,
        "long_context": false,
        "video_input_translation": false,
        "audio_input_translation": false
      }
    },
    {
      "name": "databricks-claude-opus-4-6",
      "creation_timestamp": 1770336000000,
      "last_updated_timestamp": 1770336000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-claude-opus-4-6",
            "entity_name": "system.ai.databricks-claude-opus-4-6",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-claude-opus-4-6",
              "display_name": "Claude Opus 4.6",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#claude-opus-4-6",
              "description": "Claude Opus 4.6 is Anthropic's most capable hybrid reasoning model with adaptive thinking capabilities. This model introduces a new max effort level for the most demanding tasks, with high effort set as the default for optimal performance. Claude Opus 4.6 excels at complex reasoning, deep analysis, code generation, research, and sophisticated multi-step workflows. It features a 1 million token context window, making it ideal for enterprise applications that require both extensive analysis and comprehensive outputs. This endpoint is hosted by Databricks.",
              "price": "357.143",
              "input_price": "71.429",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "claude",
              "api_types": [
                "mlflow/v1/chat/completions",
                "anthropic/v1/messages",
                "cursor/v1/chat/completions"
              ],
              "ai_gateway_model_profile": {
                "speed": 43.7,
                "cost": 10.0,
                "quality": 46.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "openai_reasoning": false,
        "anthropic_reasoning": false,
        "image_input": true,
        "long_context": true,
        "video_input_translation": false,
        "audio_input_translation": false
      }
    },
    {
      "name": "databricks-gpt-oss-120b",
      "creation_timestamp": 1754179200000,
      "last_updated_timestamp": 1754179200000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-gpt-oss-120b",
            "entity_name": "system.ai.gpt-oss-120b",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.gpt-oss-120b",
              "display_name": "GPT OSS 120B",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#openai-gpt-120b",
              "description": "GPT OSS 120B is a state-of-the-art, reasoning model with chain-of-thought and adjustable reasoning effort levels built and trained by OpenAI. It is OpenAI's flagship open-weight model that features a 128K token context window. The model is built for high-quality reasoning tasks.",
              "price": "8.571",
              "input_price": "2.143",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "gpt-oss",
              "api_types": ["mlflow/v1/chat/completions"],
              "ai_gateway_model_profile": {
                "speed": 266.5,
                "cost": 0.26,
                "quality": 33.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "openai_reasoning": true
      }
    },
    {
      "name": "databricks-claude-sonnet-4-6",
      "creation_timestamp": 1771200000000,
      "last_updated_timestamp": 1771200000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-claude-sonnet-4-6",
            "entity_name": "system.ai.databricks-claude-sonnet-4-6",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-claude-sonnet-4-6",
              "display_name": "Claude Sonnet 4.6",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#claude-sonnet-4-6",
              "description": "Claude Sonnet 4.6 is Anthropic's most capable Sonnet-class model yet, with frontier performance across coding, agents, and professional work. It excels at iterative development, complex codebase navigation, end-to-end project management with memory, polished document creation, and confident computer use for web QA and workflow automation. This endpoint is hosted by Databricks.",
              "price": "214.286",
              "input_price": "42.857",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "claude",
              "api_types": [
                "mlflow/v1/chat/completions",
                "anthropic/v1/messages",
                "cursor/v1/chat/completions"
              ],
              "ai_gateway_model_profile": {
                "speed": 44.2,
                "cost": 6.0,
                "quality": 44.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "openai_reasoning": false,
        "anthropic_reasoning": false,
        "image_input": true,
        "long_context": true,
        "video_input_translation": false,
        "audio_input_translation": false
      }
    },
    {
      "name": "databricks-claude-sonnet-4-5",
      "creation_timestamp": 1759449600000,
      "last_updated_timestamp": 1759449600000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-claude-sonnet-4-5",
            "entity_name": "system.ai.databricks-claude-sonnet-4-5",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-claude-sonnet-4-5",
              "display_name": "Claude Sonnet 4.5",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#claude-sonnet-4-5",
              "description": "Claude Sonnet 4.5 is Anthropic's most advanced hybrid reasoning model. It offers two modes: near-instant responses and extended thinking for deeper reasoning based on the complexity of the task. Claude Sonnet 4.5 specializes in application that require a balance of practical throughput and advanced thinking such as customer-facing agents, production coding workflows, and content generation at scale. This endpoint is hosted by Databricks",
              "price": "321.429",
              "input_price": "42.857",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "claude",
              "api_types": [
                "mlflow/v1/chat/completions",
                "anthropic/v1/messages",
                "cursor/v1/chat/completions"
              ],
              "ai_gateway_model_profile": {
                "speed": 41.7,
                "cost": 6.0,
                "quality": 37.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "image_input": true,
        "long_context": true
      }
    },
    {
      "name": "databricks-claude-haiku-4-5",
      "creation_timestamp": 1766102400000,
      "last_updated_timestamp": 1766102400000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-claude-haiku-4-5",
            "entity_name": "system.ai.databricks-claude-haiku-4-5",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-claude-haiku-4-5",
              "display_name": "Claude Haiku 4.5",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#claude-haiku-4-5",
              "description": "Claude Haiku 4.5 is Anthropic's fastest and most cost efficient hybrid reasoning model, optimized for real-time use and high-volume workloads. It features two modes: quick responses for time-sensitive interactions and extended reasoning for complex problem-solving. Haiku 4.5 excels in environments like coding assistance, automated agent workflows, and enterprise-scale analysis. This endpoint is hosted by Databricks.",
              "price": "71.429",
              "input_price": "14.286",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "claude",
              "api_types": [
                "mlflow/v1/chat/completions",
                "anthropic/v1/messages",
                "cursor/v1/chat/completions"
              ],
              "ai_gateway_model_profile": {
                "speed": 96.0,
                "cost": 2.0,
                "quality": 31.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true
      }
    },
    {
      "name": "databricks-gpt-oss-20b",
      "creation_timestamp": 1754179200000,
      "last_updated_timestamp": 1754179200000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-gpt-oss-20b",
            "entity_name": "system.ai.gpt-oss-20b",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.gpt-oss-20b",
              "display_name": "GPT OSS 20B",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#openai-gpt-20b",
              "description": "GPT OSS 20B is a state-of-the-art, lightweight reasoning model built and trained by OpenAI. This model also has a 128K token context window and excels at real-time copilots and batch inference tasks.",
              "price": "4.286",
              "input_price": "1.0",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "gpt-oss",
              "api_types": ["mlflow/v1/chat/completions"],
              "ai_gateway_model_profile": {
                "speed": 263.7,
                "cost": 0.09,
                "quality": 24.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "openai_reasoning": true
      }
    },
    {
      "name": "databricks-qwen3-next-80b-a3b-instruct",
      "creation_timestamp": 1699610000000,
      "last_updated_timestamp": 1699610000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-qwen3-next-80b-a3b-instruct",
            "entity_name": "system.ai.qwen3-next-80b-a3b-instruct",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.qwen3-next-80b-a3b-instruct",
              "display_name": "Qwen3 Next Instruct",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#qwen3-next-80b-a3b-instruct",
              "description": "Qwen3-Next-80B-A3B-Instruct is a highly efficient large language model optimized for instruction-following tasks built and trained by Alibaba Cloud. This model is designed to handle ultra-long contexts and excels at multi-step workflows, retrieval-augmented generation, and enterprise applications that require deterministic outputs at high throughput. This endpoint is hosted by Databricks.",
              "price": "17.143",
              "input_price": "2.143",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "qwen",
              "api_types": ["mlflow/v1/chat/completions"],
              "ai_gateway_model_profile": {
                "speed": 152.0,
                "cost": 0.88,
                "quality": 20.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true
      }
    },
    {
      "name": "databricks-qwen35-122b-a10b",
      "creation_timestamp": 1776902400000,
      "last_updated_timestamp": 1776902400000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-qwen35-122b-a10b",
            "entity_name": "system.ai.databricks-qwen35-122b-a10b",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-qwen35-122b-a10b",
              "display_name": "Qwen3.5 122B A10B",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#qwen35-122b-a10b",
              "description": "",
              "price": "31.4285",
              "input_price": "3.14285",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "qwen",
              "api_types": ["mlflow/v1/chat/completions"],
              "ai_gateway_model_profile": {
                "speed": 150.0,
                "cost": 1.1,
                "quality": 42.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "openai_reasoning": false,
        "anthropic_reasoning": false,
        "image_input": false,
        "long_context": false,
        "video_input_translation": false,
        "audio_input_translation": false
      }
    },
    {
      "name": "databricks-llama-4-maverick",
      "creation_timestamp": 1699610000000,
      "last_updated_timestamp": 1699610000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-llama-4-maverick",
            "entity_name": "system.ai.llama-4-maverick",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.llama-4-maverick",
              "display_name": "Llama 4 Maverick",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#meta-llama-4-maverick",
              "description": "Llama 4 Maverick is a state-of-the-art mixture of experts (MoE) language model trained and released by Meta, distributed by AzureML via the AzureML Model Catalog. The model has 17B active parameters, 128 experts, and 400 billion total parameters. The model supports a context length of 128K tokens. The model is optimized for multilingual dialogue use cases, supporting 12 languages, and is aligned with human preferences for helpfulness and safety. It is not intended for use in languages other than English. Llama 4 is licensed under the Meta Llama 4 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved. Customers are responsible for ensuring compliance with applicable model licenses.",
              "price": "21.429",
              "input_price": "7.143",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "llama",
              "api_types": ["mlflow/v1/chat/completions"],
              "ai_gateway_model_profile": {
                "speed": 123.5,
                "cost": 0.49,
                "quality": 18.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "image_input": true
      }
    },
    {
      "name": "databricks-gemma-3-12b",
      "creation_timestamp": 1699610000000,
      "last_updated_timestamp": 1699610000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-gemma-3-12b",
            "entity_name": "system.ai.gemma-3-12b-it",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.gemma-3-12b-it",
              "display_name": "Gemma 3 12B",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#google-gemma-3-12b",
              "description": "Gemma 3 12B is a state-of-the-art multimodal language model built and trained by Google. The model supports a context length of 128K tokens and can analyze images and text. With support for over 140 languages and optimized for dialogue use cases, Gemma 3 12B is aligned with human preferences for helpfulness and safety. This endpoint is hosted by Databricks.",
              "price": "7.143",
              "input_price": "2.143",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "gemma-3",
              "api_types": ["mlflow/v1/chat/completions"],
              "ai_gateway_model_profile": {
                "speed": 29.2,
                "cost": 0.0,
                "quality": 9.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "image_input": true
      }
    },
    {
      "name": "databricks-gte-large-en",
      "creation_timestamp": 1699610000000,
      "last_updated_timestamp": 1699610000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-gte-large-en",
            "entity_name": "system.ai.gte_large_en_v1_5",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.gte_large_en_v1_5",
              "display_name": "GTE Large (En)",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#gte-large",
              "description": "General text embeddings (GTE) can map any text to a low-dimensional dense vector which can be used for tasks like retrieval, classification, clustering, or semantic search. And it also can be used in vector databases for LLMs.",
              "price": "1.857",
              "input_price": "1.857",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "gte",
              "api_types": ["mlflow/v1/embeddings"],
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/embeddings",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {}
    },
    {
      "name": "databricks-bge-large-en",
      "creation_timestamp": 1699610000000,
      "last_updated_timestamp": 1699610000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-bge-large-en",
            "entity_name": "system.ai.bge_large_en_v1_5",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.bge_large_en_v1_5",
              "display_name": "BGE Large (En)",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#bge-large",
              "description": "BAAI general embedding (BGE) can map any text to a low-dimensional dense vector which can be used for tasks like retrieval, classification, clustering, or semantic search. And it also can be used in vector databases for LLMs.",
              "price": "1.429",
              "input_price": "1.429",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "gte",
              "api_types": ["mlflow/v1/embeddings"],
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/embeddings",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {}
    },
    {
      "name": "databricks-meta-llama-3-1-8b-instruct",
      "creation_timestamp": 1699610000000,
      "last_updated_timestamp": 1699610000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-meta-llama-3-1-8b-instruct",
            "entity_name": "system.ai.meta_llama_v3_1_8b_instruct",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.meta_llama_v3_1_8b_instruct",
              "display_name": "Meta Llama 3.1 8B Instruct",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#meta-llama-3-8b-instruct",
              "description": "Llama 3.1 is a state-of-the-art 8B parameter dense language model trained and released by Meta, distributed by AzureML via the AzureML Model Catalog. The model supports a context length of 128K tokens. The model is optimized for multilingual dialogue use cases and aligned with human preferences for helpfulness and safety. It is not intended for use in languages other than English. Meta Llama 3.1 is licensed under the Meta Llama 3.1 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved. Customers are responsible for ensuring compliance with applicable model licenses.",
              "price": "6.429",
              "input_price": "2.143",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "llama",
              "api_types": ["mlflow/v1/chat/completions"],
              "ai_gateway_model_profile": {
                "speed": 156.4,
                "cost": 0.1,
                "quality": 12.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {}
    },
    {
      "name": "databricks-meta-llama-3-3-70b-instruct",
      "creation_timestamp": 1699610000000,
      "last_updated_timestamp": 1699610000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-meta-llama-3-3-70b-instruct",
            "entity_name": "system.ai.llama_v3_3_70b_instruct",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.llama_v3_3_70b_instruct",
              "display_name": "Meta Llama 3.3 70B Instruct",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#meta-llama-33-70b-instruct",
              "description": "Llama 3.3 is a state-of-the-art 70B parameter dense language model trained and released by Meta, distributed by AzureML via the AzureML Model Catalog. The model supports a context length of 128K tokens. The model is optimized for multilingual dialogue use cases and aligned with human preferences for helpfulness and safety. It is not intended for use in languages other than English. Meta Llama 3.3 is licensed under the Meta Llama 3.3 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved. Customers are responsible for ensuring compliance with applicable model licenses.",
              "price": "21.429",
              "input_price": "7.143",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "llama",
              "api_types": ["mlflow/v1/chat/completions"],
              "ai_gateway_model_profile": {
                "speed": 86.0,
                "cost": 0.64,
                "quality": 14.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true
      }
    },
    {
      "name": "databricks-claude-opus-4-5",
      "creation_timestamp": 1763942400000,
      "last_updated_timestamp": 1763942400000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-claude-opus-4-5",
            "entity_name": "system.ai.databricks-claude-opus-4-5",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-claude-opus-4-5",
              "display_name": "Claude Opus 4.5",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#claude-opus-4-5",
              "description": "Claude Opus 4.5 is a large language model built and trained by Anthropic for production software engineering and sophisticated multi-tool agents. It supports text and image input with a 200K token context window. The model is designed for professional tasks requiring complex reasoning across multiple systems, including code generation, document creation, spreadsheets, presentations, and multi-step agent workflows. It features advanced tool use capabilities including tool search and programmatic tool calling for agents working with large tool libraries. This endpoint is hosted by Databricks.",
              "price": "357.143",
              "input_price": "71.429",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "claude",
              "api_types": [
                "mlflow/v1/chat/completions",
                "anthropic/v1/messages",
                "cursor/v1/chat/completions"
              ],
              "ai_gateway_model_profile": {
                "speed": 48.7,
                "cost": 10.0,
                "quality": 43.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "image_input": true
      }
    },
    {
      "name": "databricks-claude-opus-4-1",
      "creation_timestamp": 1756944000000,
      "last_updated_timestamp": 1756944000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-claude-opus-4-1",
            "entity_name": "system.ai.databricks-claude-opus-4-1",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-claude-opus-4-1",
              "display_name": "Claude Opus 4.1",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#claude-opus-4-1",
              "description": "Claude Opus 4.1 is a state-of-the-art, hybrid reasoning model built and trained by Anthropic. This general purpose large language model is designed for both complex reasoning and real-world applications at enterprise scale. It supports text and image input, with a 200K token context window and 32K output token capabilities. This model excels at tasks like code generation, research and content creation, and multi-step agents workflows without constant human intervention. This endpoint is hosted by Databricks.",
              "price": "1071.42",
              "input_price": "214.286",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "claude",
              "api_types": [
                "mlflow/v1/chat/completions",
                "anthropic/v1/messages",
                "cursor/v1/chat/completions"
              ],
              "ai_gateway_model_profile": {
                "speed": 31.5,
                "cost": 30.0,
                "quality": 36.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true
      }
    },
    {
      "name": "databricks-claude-sonnet-4",
      "creation_timestamp": 1747872000000,
      "last_updated_timestamp": 1747872000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-claude-sonnet-4",
            "entity_name": "system.ai.databricks-claude-sonnet-4",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.databricks-claude-sonnet-4",
              "display_name": "Claude Sonnet 4",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#claude-sonnet-4",
              "description": "Claude Sonnet 4 is a state-of-the-art, hybrid reasoning model built and trained by Anthropic. This model offers two modes: near-instant responses and extended thinking for deeper reasoning based on the complexity of the task. Claude Sonnet 4 is optimized for various tasks such as code development, large-scale content analysis, and agent application development. This endpoint is hosted by Databricks",
              "price": "214.286",
              "input_price": "42.857",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "claude",
              "api_types": [
                "mlflow/v1/chat/completions",
                "anthropic/v1/messages",
                "cursor/v1/chat/completions"
              ],
              "ai_gateway_model_profile": {
                "speed": 44.4,
                "cost": 6.0,
                "quality": 33.0
              },
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/chat",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {
        "function_calling": true,
        "image_input": true,
        "long_context": true
      }
    },
    {
      "name": "databricks-qwen3-embedding-0-6b",
      "creation_timestamp": 1699610000000,
      "last_updated_timestamp": 1699610000000,
      "state": {
        "ready": "READY",
        "config_update": "NOT_UPDATING"
      },
      "config": {
        "served_entities": [
          {
            "name": "databricks-qwen3-embedding-0-6b",
            "entity_name": "system.ai.qwen3-embedding-0-6b",
            "type": "FOUNDATION_MODEL",
            "foundation_model": {
              "name": "system.ai.qwen3-embedding-0-6b",
              "display_name": "Qwen3 Embedding 0.6B",
              "docs": "https://learn.microsoft.com/en-us/azure/databricks/machine-learning/foundation-models/supported-models#qwen3-embedding-0-6b",
              "description": "Qwen3 Embedding is a multilingual text embedding model that can map any text to a low-dimensional dense vector which can be used for tasks like retrieval, classification, clustering, or semantic search. This endpoint is hosted by Databricks.",
              "price": "0.286",
              "input_price": "0.286",
              "price_unit": "DBUs per 1M tokens",
              "pricing_model": "Pay-per-token",
              "model_class": "qwen",
              "api_types": ["mlflow/v1/embeddings"],
              "ai_gateway_v2_supported": true
            }
          }
        ]
      },
      "task": "llm/v1/embeddings",
      "endpoint_type": "FOUNDATION_MODEL_API",
      "permission_level": "CAN_MANAGE",
      "capabilities": {}
    }
  ]
}
`;

// ────────────────────────────────────────────────────────────────
// Endpoint loader
//
// Parses the inline SERVING_ENDPOITNS_JSON fixture once, memoized
// for the duration of the test run. To run against a live workspace
// instead, swap the body for `(await import("../src/models")).servingEndpoints()`
// (and bootstrap AppKit so getExecutionContext() is initialized).
// ────────────────────────────────────────────────────────────────

const getServingEndpoints = pMemoize(async (): Promise<ServingEndpoint[]> => {
  return JSON.parse(SERVING_ENDPOITNS_JSON).endpoints;
});

// ────────────────────────────────────────────────────────────────
// Ranking helpers (DRY: speed and quality both go through
// `filterByDistribution`)
// ────────────────────────────────────────────────────────────────

/**
 * Filter `items` to those whose `getValue` reading is at or above
 * the given normalized `threshold` against the pool's own
 * `[min, max]` range. If nothing passes (every value is below the
 * cutoff or the pool is uniform), fall back to the single top
 * item so the caller always gets a non-empty result on a
 * non-empty input.
 *
 * Generic over the item type so the same function ranks by speed,
 * quality, or any other numeric attribute.
 */
function filterByDistribution<T>(
  items: ReadonlyArray<T>,
  getValue: (item: T) => number,
  threshold: number,
): T[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [...items];

  let min = Infinity;
  let max = -Infinity;
  for (const item of items) {
    const v = getValue(item);
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  // Degenerate range: every item is the same (or only one finite
  // value). Threshold doesn't apply meaningfully; return the pool
  // unchanged so the caller's other filters can still narrow it.
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return [...items];
  }

  const range = max - min;
  const passing = items.filter((item) => (getValue(item) - min) / range >= threshold);
  if (passing.length > 0) return passing;

  // Nothing met the threshold (e.g. caller asked for `0.9` and
  // the top normalized score is `0.7`). Return the single highest
  // item so the contract holds: non-empty input => non-empty
  // output.
  return [topByValue(items, getValue)];
}

/** Item with the highest `getValue`. Tie-break by first occurrence. */
function topByValue<T>(items: ReadonlyArray<T>, getValue: (item: T) => number): T {
  let best = items[0]!;
  let bestScore = getValue(best);
  for (let i = 1; i < items.length; i++) {
    const candidate = items[i]!;
    const score = getValue(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────────
// Public function
// ────────────────────────────────────────────────────────────────

/** Options accepted by {@link selectEndpoints}. All fields optional. */
export interface SelectEndpointsOptions {
  /**
   * One or more `model_class` values to keep. Case-insensitive
   * (`"Claude"` matches `"claude"`). When omitted, no class
   * filtering happens.
   */
  classes?: string | ReadonlyArray<string>;
  /**
   * Speed threshold in `[0, 1]` against the candidate pool's
   * own min/max. `0.9` keeps items in the top ~10% of speeds
   * available; if nothing makes the cut, the single fastest
   * item wins.
   */
  speed?: number;
  /** Quality threshold; same semantics as {@link speed}. */
  quality?: number;
}

/**
 * Select serving endpoints by class / speed / quality. Filters
 * are applied in order:
 *
 *   1. Drop non-foundation-model endpoints (no AI Gateway
 *      profile to rank on).
 *   2. If `classes` is set, narrow to those `model_class`es.
 *   3. If `speed` is set, run {@link filterByDistribution} on
 *      the surviving pool.
 *   4. If `quality` is set, do the same.
 *
 * Each later step ranks against the already-filtered pool, so a
 * `quality: 1` call after `classes: "claude"` returns the highest-
 * quality Claude rather than the global highest-quality endpoint.
 */
export async function selectEndpoints(
  options: SelectEndpointsOptions = {},
): Promise<ServingEndpoint[]> {
  const all = await getServingEndpoints();

  // Step 1: only items with the gateway profile are rankable.
  let candidates = all.filter((e) => foundationModelProfile(e) !== undefined);

  // Step 2: class filter.
  if (options.classes !== undefined) {
    const list = Array.isArray(options.classes) ? options.classes : [options.classes];
    const lower = new Set(list.map((c) => c.toLowerCase()));
    if (lower.size > 0) {
      candidates = candidates.filter((e) => {
        const cls = foundationModelClass(e);
        return cls !== undefined && lower.has(cls.toLowerCase());
      });
    }
  }

  // Step 3: speed filter (uses the same `filterByDistribution`
  // helper as quality below). Step 1 already dropped endpoints
  // without a profile, so the `!` is safe here.
  if (options.speed !== undefined) {
    candidates = filterByDistribution(
      candidates,
      (e) => foundationModelProfile(e)!.speed,
      options.speed,
    );
  }

  // Step 4: quality filter.
  if (options.quality !== undefined) {
    candidates = filterByDistribution(
      candidates,
      (e) => foundationModelProfile(e)!.quality,
      options.quality,
    );
  }

  return candidates;
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe("selectEndpoints", () => {
  it("returns every foundation-model endpoint with no filters", async () => {
    const result = await selectEndpoints();
    expect(result.length).toBeGreaterThan(0);
    for (const e of result) expect(foundationModelProfile(e)).toBeDefined();
  });

  it("filters by a single class (case-insensitive)", async () => {
    const result = await selectEndpoints({ classes: "Claude" });
    expect(result.length).toBeGreaterThan(0);
    for (const e of result) {
      expect(foundationModelClass(e)?.toLowerCase()).toBe("claude");
    }
  });

  it("filters by multiple classes", async () => {
    const result = await selectEndpoints({ classes: ["claude", "gemini"] });
    expect(result.length).toBeGreaterThan(0);
    for (const e of result) {
      const cls = foundationModelClass(e)?.toLowerCase();
      expect(cls).toBeDefined();
      expect(["claude", "gemini"]).toContain(cls!);
    }
  });

  it("speed=1 returns just the fastest endpoint(s)", async () => {
    const result = await selectEndpoints({ speed: 1 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    const all = await selectEndpoints();
    const fastest = topByValue(all, (e) => foundationModelProfile(e)!.speed);
    expect(foundationModelProfile(result[0]!)!.speed).toBe(
      foundationModelProfile(fastest)!.speed,
    );
  });

  it("speed=0 keeps the whole pool", async () => {
    const all = await selectEndpoints();
    const result = await selectEndpoints({ speed: 0 });
    expect(result.length).toBe(all.length);
  });

  it("quality=1 narrows to the highest-quality endpoint(s)", async () => {
    const all = await selectEndpoints();
    const result = await selectEndpoints({ quality: 1 });
    const best = topByValue(all, (e) => foundationModelProfile(e)!.quality);
    expect(foundationModelProfile(result[0]!)!.quality).toBe(
      foundationModelProfile(best)!.quality,
    );
  });

  it("class + speed + quality compose left-to-right", async () => {
    // "Best Claude for speed-then-quality" - typical use case.
    const result = await selectEndpoints({
      classes: "claude",
      speed: 0.5,
      quality: 0.8,
    });
    expect(result.length).toBeGreaterThan(0);
    for (const e of result) {
      expect(foundationModelClass(e)?.toLowerCase()).toBe("claude");
    }
  });

  it("falls back to the single top item when nothing meets a strict threshold", async () => {
    // Class with sparse offerings + a high speed cut: even if
    // nothing strictly clears 0.95 in the surviving pool, the
    // function returns one item (the fastest in that pool).
    const result = await selectEndpoints({
      classes: "claude",
      speed: 0.99,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects unknown classes by returning empty", async () => {
    const result = await selectEndpoints({ classes: "totally-fake-class" });
    expect(result).toEqual([]);
  });
});

describe("foundationModelVersion", () => {
  // Look up a fixture endpoint by exact `name`, asserting it exists.
  async function endpointByName(name: string): Promise<ServingEndpoint> {
    const all = await getServingEndpoints();
    const found = all.find((e) => e.name === name);
    expect(found, `fixture endpoint not found: ${name}`).toBeDefined();
    return found!;
  }

  it("returns undefined for endpoints whose served entities are not FOUNDATION_MODEL", async () => {
    // `lensiq-*` and `guest-promise-time-v2` are UC_MODEL entries
    // in the fixture, so `foundationModels()` yields nothing and
    // version derivation short-circuits to `undefined`.
    expect(
      foundationModelVersion(await endpointByName("lensiq-detector")),
    ).toBeUndefined();
    expect(
      foundationModelVersion(await endpointByName("guest-promise-time-v2")),
    ).toBeUndefined();
  });

  it("returns undefined for foundation models with no digits in the endpoint name", async () => {
    expect(
      foundationModelVersion(await endpointByName("databricks-gte-large-en")),
    ).toBeUndefined();
    expect(
      foundationModelVersion(await endpointByName("databricks-bge-large-en")),
    ).toBeUndefined();
  });

  it("expands two numeric chunks to MAJOR.MINOR.0", async () => {
    expect(
      foundationModelVersion(await endpointByName("databricks-claude-opus-4-7")),
    ).toBe("4.7.0");
    expect(
      foundationModelVersion(await endpointByName("databricks-claude-sonnet-4-5")),
    ).toBe("4.5.0");
    expect(
      foundationModelVersion(await endpointByName("databricks-claude-opus-4-1")),
    ).toBe("4.1.0");
  });

  it("expands a single numeric chunk to MAJOR.0.0", async () => {
    expect(
      foundationModelVersion(await endpointByName("databricks-claude-sonnet-4")),
    ).toBe("4.0.0");
    expect(
      foundationModelVersion(await endpointByName("databricks-llama-4-maverick")),
    ).toBe("4.0.0");
  });

  it("splits numeric+letter chunks: numeric goes into versionParts, full chunk into suffix", async () => {
    // `120b` -> versionParts ["120"] padded to ["120","0","0"], suffix ["120b"].
    expect(
      foundationModelVersion(await endpointByName("databricks-gpt-oss-120b")),
    ).toBe("120.0.0.120b");
    expect(foundationModelVersion(await endpointByName("databricks-gpt-oss-20b"))).toBe(
      "20.0.0.20b",
    );
    // `3` is pure-numeric (no suffix contribution); `12b` contributes "12"
    // to versionParts and "12b" to the suffix.
    expect(foundationModelVersion(await endpointByName("databricks-gemma-3-12b"))).toBe(
      "3.12.0.12b",
    );
  });

  it("captures multiple numeric+letter chunks in order, joining suffixes", async () => {
    expect(
      foundationModelVersion(
        await endpointByName("databricks-qwen3-next-80b-a3b-instruct"),
      ),
    ).toBe("3.80.3.80ba3b");
    expect(
      foundationModelVersion(await endpointByName("databricks-qwen35-122b-a10b")),
    ).toBe("35.122.10.122ba10b");
    expect(
      foundationModelVersion(
        await endpointByName("databricks-meta-llama-3-1-8b-instruct"),
      ),
    ).toBe("3.1.8.8b");
    expect(
      foundationModelVersion(
        await endpointByName("databricks-meta-llama-3-3-70b-instruct"),
      ),
    ).toBe("3.3.70.70b");
  });
});

describe("filterByDistribution", () => {
  it("keeps items at or above the normalized threshold", () => {
    const items = [{ v: 10 }, { v: 20 }, { v: 30 }, { v: 40 }, { v: 50 }];
    // threshold 0.5 -> normalized cutoff is 30; 30/40/50 pass.
    const result = filterByDistribution(items, (i) => i.v, 0.5);
    expect(result.map((i) => i.v)).toEqual([30, 40, 50]);
  });

  it("returns the highest item when nothing meets the threshold", () => {
    // Build a synthetic case: threshold > 1 (impossible) forces
    // the fallback path.
    const items = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const result = filterByDistribution(items, (i) => i.v, 1.5);
    expect(result.map((i) => i.v)).toEqual([30]);
  });

  it("returns the pool unchanged when min == max", () => {
    const items = [{ v: 5 }, { v: 5 }, { v: 5 }];
    const result = filterByDistribution(items, (i) => i.v, 0.7);
    expect(result.length).toBe(3);
  });

  it("handles a single-item pool", () => {
    const items = [{ v: 42 }];
    const result = filterByDistribution(items, (i) => i.v, 0.99);
    expect(result).toEqual(items);
  });
});

// ────────────────────────────────────────────────────────────────
// Examples (printed inline during `bun test`)
//
// These aren't assertions; they exist to give a feel for what
// each filter combo actually selects against the live workspace.
// Bun's test runner shows `console.log` output by default, so
// running `bun test packages/serving/test/models.test.ts`
// prints a small table per scenario right under the `(pass)` line.
//
// To make the output even louder (full per-test logs even on
// pass), pass `--verbose`:
//   bun test --verbose packages/serving/test/models.test.ts
//
// To silence the examples without losing the assertions, set the
// env var: `EXAMPLES=0 bun test ...` (the suite below skips when
// it's set to a falsy value).
// ────────────────────────────────────────────────────────────────

const EXAMPLES_ENABLED = (() => {
  const raw = process.env.EXAMPLES?.toLowerCase().trim();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
})();

const exampleSuite = EXAMPLES_ENABLED ? describe : describe.skip;

/**
 * Compact one-line summary of a single endpoint - just enough to
 * eyeball whether the right ones got picked.
 */
function summarize(e: ServingEndpoint): string {
  const profile = foundationModelProfile(e);
  const cls = (foundationModelClass(e) ?? "?").padEnd(12);
  const ver = (foundationModelVersion(e) ?? "?").padEnd(18);
  const s = String(profile?.speed ?? "?").padStart(6);
  const q = String(profile?.quality ?? "?").padStart(5);
  return `  ${e.name.padEnd(48)}  class=${cls}  version=${ver}  speed=${s}  quality=${q}`;
}

/**
 * Print a labeled block of selected endpoints. Flushed via
 * console.log so Bun's test output captures it (works under both
 * default and `--verbose`).
 */
function show(label: string, items: ReadonlyArray<ServingEndpoint>): void {
  // eslint-disable-next-line no-console
  console.log(`\n${label} (${items.length} match):`);
  if (items.length === 0) {
    // eslint-disable-next-line no-console
    console.log("  <none>");
    return;
  }
  for (const e of items) {
    // eslint-disable-next-line no-console
    console.log(summarize(e));
  }
}

exampleSuite("selectEndpoints (examples)", () => {
  it("everything", async () => {
    show("no filters", await selectEndpoints());
  });

  it("classes=claude", async () => {
    show("classes=claude", await selectEndpoints({ classes: "claude" }));
  });

  it("classes=[claude,gemini]", async () => {
    show(
      "classes=[claude, gemini]",
      await selectEndpoints({ classes: ["claude", "gemini"] }),
    );
  });

  it("speed=0.9 (top ~10% of speed)", async () => {
    show("speed=0.9", await selectEndpoints({ speed: 0.9 }));
  });

  it("quality=0.9 (top ~10% of quality)", async () => {
    show("quality=0.9", await selectEndpoints({ quality: 0.9 }));
  });

  it("classes=claude, speed=0.5, quality=0.8", async () => {
    show(
      "classes=claude, speed=0.5, quality=0.8",
      await selectEndpoints({
        classes: "claude",
        speed: 0.5,
        quality: 0.8,
      }),
    );
  });

  it("classes=claude, speed=0.99 (fallback to fastest claude)", async () => {
    show(
      "classes=claude, speed=0.99 (forces fallback)",
      await selectEndpoints({ classes: "claude", speed: 0.99 }),
    );
  });
});

exampleSuite("foundationModelVersion (examples)", () => {
  it("derives a version from every fixture endpoint", async () => {
    const all = await getServingEndpoints();
    // eslint-disable-next-line no-console
    console.log(`\nname -> foundationModelVersion (${all.length} endpoints):`);
    for (const e of all) {
      const v = foundationModelVersion(e) ?? "<undefined>";
      // eslint-disable-next-line no-console
      console.log(`  ${e.name.padEnd(48)}  ${v}`);
    }
  });
});
