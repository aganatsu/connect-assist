export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      active_direction_verdicts: {
        Row: {
          agreement: number
          block_reason: string | null
          bot_id: string
          confidence: number
          contract_version: string
          created_at: string
          evaluated_at: string
          expires_at: string
          game_plan_id: string | null
          game_plan_version: string | null
          id: string
          is_active: boolean
          scan_cycle_id: string | null
          score_adjustment: number
          should_block: boolean
          source_candle_timestamp: string | null
          style_base_policy_hash: string | null
          style_policy: Json | null
          style_policy_hash: string | null
          style_policy_version: string | null
          superseded_at: string | null
          symbol: string
          user_id: string
          verdict: string
          verdict_json: Json
          verdict_version: string
        }
        Insert: {
          agreement: number
          block_reason?: string | null
          bot_id?: string
          confidence: number
          contract_version?: string
          created_at?: string
          evaluated_at: string
          expires_at: string
          game_plan_id?: string | null
          game_plan_version?: string | null
          id?: string
          is_active?: boolean
          scan_cycle_id?: string | null
          score_adjustment?: number
          should_block: boolean
          source_candle_timestamp?: string | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          superseded_at?: string | null
          symbol: string
          user_id: string
          verdict: string
          verdict_json: Json
          verdict_version: string
        }
        Update: {
          agreement?: number
          block_reason?: string | null
          bot_id?: string
          confidence?: number
          contract_version?: string
          created_at?: string
          evaluated_at?: string
          expires_at?: string
          game_plan_id?: string | null
          game_plan_version?: string | null
          id?: string
          is_active?: boolean
          scan_cycle_id?: string | null
          score_adjustment?: number
          should_block?: boolean
          source_candle_timestamp?: string | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          superseded_at?: string | null
          symbol?: string
          user_id?: string
          verdict?: string
          verdict_json?: Json
          verdict_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "active_direction_verdicts_game_plan_id_fkey"
            columns: ["game_plan_id"]
            isOneToOne: false
            referencedRelation: "active_game_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      active_game_plans: {
        Row: {
          bias: string
          bias_confidence: number
          bot_id: string
          config_snapshot: Json
          contract_version: string
          created_at: string
          expires_at: string
          focus_pairs: Json
          generated_at: string
          generation_source: string
          id: string
          invalidation_conditions: Json
          is_active: boolean
          market_data_snapshot: Json
          news_events: Json
          news_impacts: Json
          plan_json: Json
          plan_version: string
          session: string
          source_candle_timestamps: Json
          state: string
          state_reason: string | null
          style_base_policy_hash: string | null
          style_policy: Json | null
          style_policy_hash: string | null
          style_policy_version: string | null
          summary: string
          superseded_at: string | null
          symbol: string
          user_id: string
          v2_conviction: Json
        }
        Insert: {
          bias: string
          bias_confidence: number
          bot_id?: string
          config_snapshot?: Json
          contract_version?: string
          created_at?: string
          expires_at: string
          focus_pairs?: Json
          generated_at: string
          generation_source: string
          id?: string
          invalidation_conditions?: Json
          is_active?: boolean
          market_data_snapshot?: Json
          news_events?: Json
          news_impacts?: Json
          plan_json: Json
          plan_version: string
          session: string
          source_candle_timestamps?: Json
          state: string
          state_reason?: string | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          summary?: string
          superseded_at?: string | null
          symbol: string
          user_id: string
          v2_conviction?: Json
        }
        Update: {
          bias?: string
          bias_confidence?: number
          bot_id?: string
          config_snapshot?: Json
          contract_version?: string
          created_at?: string
          expires_at?: string
          focus_pairs?: Json
          generated_at?: string
          generation_source?: string
          id?: string
          invalidation_conditions?: Json
          is_active?: boolean
          market_data_snapshot?: Json
          news_events?: Json
          news_impacts?: Json
          plan_json?: Json
          plan_version?: string
          session?: string
          source_candle_timestamps?: Json
          state?: string
          state_reason?: string | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          summary?: string
          superseded_at?: string | null
          symbol?: string
          user_id?: string
          v2_conviction?: Json
        }
        Relationships: []
      }
      api_credit_usage: {
        Row: {
          caller: string | null
          id: number
          provider: string
          reserved_at: string
        }
        Insert: {
          caller?: string | null
          id?: number
          provider: string
          reserved_at?: string
        }
        Update: {
          caller?: string | null
          id?: number
          provider?: string
          reserved_at?: string
        }
        Relationships: []
      }
      backtest_history_datasets: {
        Row: {
          base_timeframe: string
          candle_count: number
          created_at: string
          end_at: string
          id: string
          original_filename: string
          source: string
          start_at: string
          storage_path: string
          symbol: string
          timezone: string
          user_id: string
          validation: Json
        }
        Insert: {
          base_timeframe?: string
          candle_count: number
          created_at?: string
          end_at: string
          id?: string
          original_filename: string
          source?: string
          start_at: string
          storage_path: string
          symbol: string
          timezone?: string
          user_id: string
          validation?: Json
        }
        Update: {
          base_timeframe?: string
          candle_count?: number
          created_at?: string
          end_at?: string
          id?: string
          original_filename?: string
          source?: string
          start_at?: string
          storage_path?: string
          symbol?: string
          timezone?: string
          user_id?: string
          validation?: Json
        }
        Relationships: []
      }
      backtest_runs: {
        Row: {
          completed_at: string | null
          config: Json
          created_at: string
          error_message: string | null
          heartbeat_at: string | null
          id: string
          progress: number
          progress_message: string | null
          results: Json | null
          started_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          config?: Json
          created_at?: string
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          progress?: number
          progress_message?: string | null
          results?: Json | null
          started_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          config?: Json
          created_at?: string
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          progress?: number
          progress_message?: string | null
          results?: Json | null
          started_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      bot_config_change_log: {
        Row: {
          change_type: string
          changed_at: string
          changed_by: string | null
          config_id: string | null
          connection_id: string | null
          id: string
          next_config: Json | null
          next_hash: string | null
          previous_config: Json | null
          previous_hash: string | null
          user_id: string
        }
        Insert: {
          change_type: string
          changed_at?: string
          changed_by?: string | null
          config_id?: string | null
          connection_id?: string | null
          id?: string
          next_config?: Json | null
          next_hash?: string | null
          previous_config?: Json | null
          previous_hash?: string | null
          user_id: string
        }
        Update: {
          change_type?: string
          changed_at?: string
          changed_by?: string | null
          config_id?: string | null
          connection_id?: string | null
          id?: string
          next_config?: Json | null
          next_hash?: string | null
          previous_config?: Json | null
          previous_hash?: string | null
          user_id?: string
        }
        Relationships: []
      }
      bot_configs: {
        Row: {
          config_json: Json
          connection_id: string | null
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          config_json?: Json
          connection_id?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          config_json?: Json
          connection_id?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_configs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "broker_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_recommendations: {
        Row: {
          bot_id: string
          created_at: string
          diagnosis: string
          feature_gaps: Json
          id: string
          impact_snapshot: Json | null
          llm_model: string | null
          overall_assessment: string | null
          performance_summary: Json
          recommendations: Json
          resolved_at: string | null
          resolved_by: string | null
          review_type: string
          status: string
          token_usage: Json | null
          user_id: string
        }
        Insert: {
          bot_id?: string
          created_at?: string
          diagnosis?: string
          feature_gaps?: Json
          id?: string
          impact_snapshot?: Json | null
          llm_model?: string | null
          overall_assessment?: string | null
          performance_summary?: Json
          recommendations?: Json
          resolved_at?: string | null
          resolved_by?: string | null
          review_type?: string
          status?: string
          token_usage?: Json | null
          user_id: string
        }
        Update: {
          bot_id?: string
          created_at?: string
          diagnosis?: string
          feature_gaps?: Json
          id?: string
          impact_snapshot?: Json | null
          llm_model?: string | null
          overall_assessment?: string | null
          performance_summary?: Json
          recommendations?: Json
          resolved_at?: string | null
          resolved_by?: string | null
          review_type?: string
          status?: string
          token_usage?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      broker_connections: {
        Row: {
          account_id: string
          api_key: string
          broker_type: string
          commission_per_lot: number
          created_at: string
          detected_commission_per_lot: number | null
          display_name: string
          id: string
          is_active: boolean
          is_live: boolean
          symbol_overrides: Json
          symbol_suffix: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id: string
          api_key: string
          broker_type: string
          commission_per_lot?: number
          created_at?: string
          detected_commission_per_lot?: number | null
          display_name: string
          id?: string
          is_active?: boolean
          is_live?: boolean
          symbol_overrides?: Json
          symbol_suffix?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account_id?: string
          api_key?: string
          broker_type?: string
          commission_per_lot?: number
          created_at?: string
          detected_commission_per_lot?: number | null
          display_name?: string
          id?: string
          is_active?: boolean
          is_live?: boolean
          symbol_overrides?: Json
          symbol_suffix?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      broker_execution_ledger: {
        Row: {
          action: string
          attempt_count: number
          bot_id: string
          broker_connection_id: string
          broker_order_id: string | null
          claim_token: string
          created_at: string
          finished_at: string | null
          id: string
          last_error: string | null
          position_id: string
          request_payload: Json
          response_payload: Json | null
          route: string
          started_at: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          action?: string
          attempt_count?: number
          bot_id?: string
          broker_connection_id: string
          broker_order_id?: string | null
          claim_token?: string
          created_at?: string
          finished_at?: string | null
          id?: string
          last_error?: string | null
          position_id: string
          request_payload?: Json
          response_payload?: Json | null
          route: string
          started_at?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          action?: string
          attempt_count?: number
          bot_id?: string
          broker_connection_id?: string
          broker_order_id?: string | null
          claim_token?: string
          created_at?: string
          finished_at?: string | null
          id?: string
          last_error?: string | null
          position_id?: string
          request_payload?: Json
          response_payload?: Json | null
          route?: string
          started_at?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "broker_execution_ledger_broker_connection_id_fkey"
            columns: ["broker_connection_id"]
            isOneToOne: false
            referencedRelation: "broker_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      close_audit_log: {
        Row: {
          broker_connection_id: string | null
          close_reason: string
          close_source: string
          created_at: string
          detail_json: Json | null
          exit_price: string | null
          id: string
          pnl: string | null
          position_id: string
          scan_cycle_id: string | null
          symbol: string
          user_id: string
        }
        Insert: {
          broker_connection_id?: string | null
          close_reason: string
          close_source: string
          created_at?: string
          detail_json?: Json | null
          exit_price?: string | null
          id?: string
          pnl?: string | null
          position_id: string
          scan_cycle_id?: string | null
          symbol: string
          user_id: string
        }
        Update: {
          broker_connection_id?: string | null
          close_reason?: string
          close_source?: string
          created_at?: string
          detail_json?: Json | null
          exit_price?: string | null
          id?: string
          pnl?: string | null
          position_id?: string
          scan_cycle_id?: string | null
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      config_backups: {
        Row: {
          backup_id: string
          config_id: string
          config_snapshot: Json
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          backup_id: string
          config_id: string
          config_snapshot?: Json
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          backup_id?: string
          config_id?: string
          config_snapshot?: Json
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      config_presets: {
        Row: {
          config_json: Json
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          config_json?: Json
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          config_json?: Json
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      game_plan_refresh_status: {
        Row: {
          active_plan_expires_at: string | null
          bot_id: string
          details: Json
          failure_code: string | null
          failure_message: string | null
          last_attempt_at: string | null
          last_success_at: string | null
          next_retry_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active_plan_expires_at?: string | null
          bot_id?: string
          details?: Json
          failure_code?: string | null
          failure_message?: string | null
          last_attempt_at?: string | null
          last_success_at?: string | null
          next_retry_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          active_plan_expires_at?: string | null
          bot_id?: string
          details?: Json
          failure_code?: string | null
          failure_message?: string | null
          last_attempt_at?: string | null
          last_success_at?: string | null
          next_retry_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ict_entry_zone_authority_observations: {
        Row: {
          activation_eligible: boolean
          authority_candidate_id: string
          authority_observation: Json
          authority_score: number
          authority_zone_high: number
          authority_zone_low: number
          authority_zone_type: string
          bot_id: string
          component_ids: string[]
          created_at: string
          direction: string
          disagreed: boolean
          entry_price: number
          evidence_source: string
          id: string
          legacy_candidate_id: string | null
          legacy_outcome_status: string | null
          legacy_zone_high: number | null
          legacy_zone_low: number | null
          legacy_zone_type: string | null
          mae_pips: number | null
          mfe_pips: number | null
          observed_at: string
          outcome_checked_at: string | null
          outcome_status: string
          price_reached_entry: boolean | null
          replay_contract_version: string | null
          replay_run_id: string | null
          scan_cycle_id: string
          sl_hit: boolean | null
          stop_loss: number
          symbol: string
          take_profit: number
          tp_hit: boolean | null
          trading_style: string
          user_id: string
        }
        Insert: {
          activation_eligible?: boolean
          authority_candidate_id: string
          authority_observation: Json
          authority_score: number
          authority_zone_high: number
          authority_zone_low: number
          authority_zone_type: string
          bot_id?: string
          component_ids?: string[]
          created_at?: string
          direction: string
          disagreed?: boolean
          entry_price: number
          evidence_source?: string
          id?: string
          legacy_candidate_id?: string | null
          legacy_outcome_status?: string | null
          legacy_zone_high?: number | null
          legacy_zone_low?: number | null
          legacy_zone_type?: string | null
          mae_pips?: number | null
          mfe_pips?: number | null
          observed_at: string
          outcome_checked_at?: string | null
          outcome_status?: string
          price_reached_entry?: boolean | null
          replay_contract_version?: string | null
          replay_run_id?: string | null
          scan_cycle_id: string
          sl_hit?: boolean | null
          stop_loss: number
          symbol: string
          take_profit: number
          tp_hit?: boolean | null
          trading_style: string
          user_id: string
        }
        Update: {
          activation_eligible?: boolean
          authority_candidate_id?: string
          authority_observation?: Json
          authority_score?: number
          authority_zone_high?: number
          authority_zone_low?: number
          authority_zone_type?: string
          bot_id?: string
          component_ids?: string[]
          created_at?: string
          direction?: string
          disagreed?: boolean
          entry_price?: number
          evidence_source?: string
          id?: string
          legacy_candidate_id?: string | null
          legacy_outcome_status?: string | null
          legacy_zone_high?: number | null
          legacy_zone_low?: number | null
          legacy_zone_type?: string | null
          mae_pips?: number | null
          mfe_pips?: number | null
          observed_at?: string
          outcome_checked_at?: string | null
          outcome_status?: string
          price_reached_entry?: boolean | null
          replay_contract_version?: string | null
          replay_run_id?: string | null
          scan_cycle_id?: string
          sl_hit?: boolean | null
          stop_loss?: number
          symbol?: string
          take_profit?: number
          tp_hit?: boolean | null
          trading_style?: string
          user_id?: string
        }
        Relationships: []
      }
      impulse_entry_lifecycle_replays: {
        Row: {
          bot_id: string
          contract_version: string
          entered: boolean
          evidence_source: string
          id: string
          lifecycle_id: string
          mae: number | null
          mfe: number | null
          outcome: string
          replayed_at: string
          rescued_deeper_entry: boolean
          result: Json
          retained_winner: boolean
          snapshot_id: string
          user_id: string
        }
        Insert: {
          bot_id?: string
          contract_version?: string
          entered: boolean
          evidence_source?: string
          id?: string
          lifecycle_id: string
          mae?: number | null
          mfe?: number | null
          outcome: string
          replayed_at?: string
          rescued_deeper_entry: boolean
          result: Json
          retained_winner: boolean
          snapshot_id: string
          user_id: string
        }
        Update: {
          bot_id?: string
          contract_version?: string
          entered?: boolean
          evidence_source?: string
          id?: string
          lifecycle_id?: string
          mae?: number | null
          mfe?: number | null
          outcome?: string
          replayed_at?: string
          rescued_deeper_entry?: boolean
          result?: Json
          retained_winner?: boolean
          snapshot_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "impulse_entry_lifecycle_replays_lifecycle_id_fkey"
            columns: ["lifecycle_id"]
            isOneToOne: false
            referencedRelation: "impulse_entry_lifecycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "impulse_entry_lifecycle_replays_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "scan_candle_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      impulse_entry_lifecycle_transitions: {
        Row: {
          created_at: string
          event_payload: Json
          event_type: string
          from_candidate_id: string | null
          from_revision: number
          id: string
          lifecycle_id: string
          lifecycle_snapshot: Json
          reason: string
          to_candidate_id: string | null
          to_revision: number
          user_id: string
        }
        Insert: {
          created_at?: string
          event_payload?: Json
          event_type: string
          from_candidate_id?: string | null
          from_revision: number
          id?: string
          lifecycle_id: string
          lifecycle_snapshot: Json
          reason: string
          to_candidate_id?: string | null
          to_revision: number
          user_id: string
        }
        Update: {
          created_at?: string
          event_payload?: Json
          event_type?: string
          from_candidate_id?: string | null
          from_revision?: number
          id?: string
          lifecycle_id?: string
          lifecycle_snapshot?: Json
          reason?: string
          to_candidate_id?: string | null
          to_revision?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "impulse_entry_lifecycle_transitions_lifecycle_id_fkey"
            columns: ["lifecycle_id"]
            isOneToOne: false
            referencedRelation: "impulse_entry_lifecycles"
            referencedColumns: ["id"]
          },
        ]
      }
      impulse_entry_lifecycles: {
        Row: {
          active_candidate_id: string | null
          bot_id: string
          created_at: string
          direction: string
          id: string
          impulse_id: string
          impulse_timeframe: string
          lifecycle: Json
          mode: string
          revision: number
          setup_id: string
          status: string
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active_candidate_id?: string | null
          bot_id?: string
          created_at?: string
          direction: string
          id?: string
          impulse_id: string
          impulse_timeframe: string
          lifecycle: Json
          mode?: string
          revision?: number
          setup_id: string
          status?: string
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          active_candidate_id?: string | null
          bot_id?: string
          created_at?: string
          direction?: string
          id?: string
          impulse_id?: string
          impulse_timeframe?: string
          lifecycle?: Json
          mode?: string
          revision?: number
          setup_id?: string
          status?: string
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      impulse_lifecycle_enforcement_certificates: {
        Row: {
          added_losses: number
          bot_id: string
          evidence: Json
          evidence_hash: string
          generated_at: string
          id: string
          is_current: boolean
          minimum_sample_ready: boolean
          replay_count: number
          rescued_winners: number
          resolved_count: number
          reviewed: boolean
          reviewed_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          added_losses: number
          bot_id?: string
          evidence: Json
          evidence_hash: string
          generated_at?: string
          id?: string
          is_current?: boolean
          minimum_sample_ready: boolean
          replay_count: number
          rescued_winners: number
          resolved_count: number
          reviewed?: boolean
          reviewed_at?: string | null
          status: string
          user_id: string
        }
        Update: {
          added_losses?: number
          bot_id?: string
          evidence?: Json
          evidence_hash?: string
          generated_at?: string
          id?: string
          is_current?: boolean
          minimum_sample_ready?: boolean
          replay_count?: number
          rescued_winners?: number
          resolved_count?: number
          reviewed?: boolean
          reviewed_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      kv_cache: {
        Row: {
          expires_at: string
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          expires_at: string
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          expires_at?: string
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      manual_impulses: {
        Row: {
          bot_id: string
          created_at: string
          direction: string
          expires_at: string
          high: number
          high_time: string | null
          id: string
          last_resolution_detail: string | null
          last_resolved_at: string | null
          low: number
          low_time: string | null
          resolution_reason: string | null
          status: string
          symbol: string
          timeframe: string
          updated_at: string
          user_id: string
        }
        Insert: {
          bot_id?: string
          created_at?: string
          direction: string
          expires_at: string
          high: number
          high_time?: string | null
          id?: string
          last_resolution_detail?: string | null
          last_resolved_at?: string | null
          low: number
          low_time?: string | null
          resolution_reason?: string | null
          status?: string
          symbol: string
          timeframe?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          bot_id?: string
          created_at?: string
          direction?: string
          expires_at?: string
          high?: number
          high_time?: string | null
          id?: string
          last_resolution_detail?: string | null
          last_resolved_at?: string | null
          low?: number
          low_time?: string | null
          resolution_reason?: string | null
          status?: string
          symbol?: string
          timeframe?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      optimizer_runs: {
        Row: {
          auto_applied: boolean | null
          baseline_score: number | null
          best_score: number | null
          completed_at: string | null
          config_snapshot: Json | null
          error_message: string | null
          id: string
          improvement_percent: number | null
          progress: number | null
          progress_message: string | null
          reject_reason: string | null
          result_summary: Json | null
          started_at: string
          status: string
          trials_count: number | null
          user_id: string
        }
        Insert: {
          auto_applied?: boolean | null
          baseline_score?: number | null
          best_score?: number | null
          completed_at?: string | null
          config_snapshot?: Json | null
          error_message?: string | null
          id?: string
          improvement_percent?: number | null
          progress?: number | null
          progress_message?: string | null
          reject_reason?: string | null
          result_summary?: Json | null
          started_at?: string
          status?: string
          trials_count?: number | null
          user_id: string
        }
        Update: {
          auto_applied?: boolean | null
          baseline_score?: number | null
          best_score?: number | null
          completed_at?: string | null
          config_snapshot?: Json | null
          error_message?: string | null
          id?: string
          improvement_percent?: number | null
          progress?: number | null
          progress_message?: string | null
          reject_reason?: string | null
          result_summary?: Json | null
          started_at?: string
          status?: string
          trials_count?: number | null
          user_id?: string
        }
        Relationships: []
      }
      paper_accounts: {
        Row: {
          balance: number | null
          balance_old: string
          bot_id: string | null
          created_at: string
          daily_pnl_base: number | null
          daily_pnl_base_date: string | null
          daily_pnl_base_old: string
          daily_pnl_date: string
          enable_orphan_close: boolean
          execution_mode: string
          id: string
          is_paused: boolean
          is_running: boolean
          kill_switch_active: boolean
          peak_balance: number | null
          peak_balance_old: string
          rejected_count: number
          scan_count: number
          scan_lock_until: string | null
          signal_count: number
          started_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          balance?: number | null
          balance_old?: string
          bot_id?: string | null
          created_at?: string
          daily_pnl_base?: number | null
          daily_pnl_base_date?: string | null
          daily_pnl_base_old?: string
          daily_pnl_date?: string
          enable_orphan_close?: boolean
          execution_mode?: string
          id?: string
          is_paused?: boolean
          is_running?: boolean
          kill_switch_active?: boolean
          peak_balance?: number | null
          peak_balance_old?: string
          rejected_count?: number
          scan_count?: number
          scan_lock_until?: string | null
          signal_count?: number
          started_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          balance?: number | null
          balance_old?: string
          bot_id?: string | null
          created_at?: string
          daily_pnl_base?: number | null
          daily_pnl_base_date?: string | null
          daily_pnl_base_old?: string
          daily_pnl_date?: string
          enable_orphan_close?: boolean
          execution_mode?: string
          id?: string
          is_paused?: boolean
          is_running?: boolean
          kill_switch_active?: boolean
          peak_balance?: number | null
          peak_balance_old?: string
          rejected_count?: number
          scan_count?: number
          scan_lock_until?: string | null
          signal_count?: number
          started_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_positions: {
        Row: {
          bot_id: string | null
          broker_close_error: string | null
          broker_close_state: string
          broker_execution_error: string | null
          broker_execution_state: string
          broker_execution_updated_at: string | null
          candidate_id: string | null
          canonical_dealing_range: Json | null
          canonical_dealing_range_impulse_id: string | null
          canonical_dealing_range_timeframe: string | null
          canonical_dealing_range_version: string | null
          close_reason: string | null
          confirmation_config: Json
          confirmation_method: string | null
          created_at: string
          cross_tf_context_version: string | null
          cross_tf_effective_mode: string | null
          cross_tf_entry_allowed: boolean | null
          cross_tf_entry_authority: Json | null
          cross_tf_relationship: string | null
          cross_tf_timeframe_evidence_id: string | null
          current_price: number | null
          current_price_old: string | null
          decision_context: Json | null
          direction: string
          direction_verdict: Json | null
          direction_verdict_id: string | null
          entry_confirmation: Json | null
          entry_price: number | null
          entry_price_old: string | null
          final_authorization: Json | null
          frozen_strategy_context: Json | null
          frozen_strategy_hash: string | null
          game_plan_id: string | null
          game_plan_version: string | null
          id: string
          impulse_entry_lifecycle: Json | null
          impulse_entry_lifecycle_id: string | null
          mirrored_connection_ids: string[]
          open_time: string
          order_id: string
          order_type: string | null
          originating_zone: Json | null
          partial_tp_fired: boolean
          policy_frozen_at: string | null
          position_id: string
          position_status: string
          signal_reason: string | null
          signal_score: string
          size: number | null
          size_old: string | null
          source_candidate_key: string | null
          source_pending_order_id: string | null
          staged_setup_id: string | null
          stop_loss: number | null
          stop_loss_old: string | null
          streamlined_decision_frozen_at: string | null
          streamlined_decision_latest: Json | null
          streamlined_decision_origin: Json | null
          style_base_policy_hash: string | null
          style_policy: Json | null
          style_policy_hash: string | null
          style_policy_version: string | null
          symbol: string
          take_profit: number | null
          take_profit_old: string | null
          thesis_validation: Json | null
          thesis_version: string | null
          trade_overrides: Json | null
          trigger_price: string | null
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          broker_close_error?: string | null
          broker_close_state?: string
          broker_execution_error?: string | null
          broker_execution_state?: string
          broker_execution_updated_at?: string | null
          candidate_id?: string | null
          canonical_dealing_range?: Json | null
          canonical_dealing_range_impulse_id?: string | null
          canonical_dealing_range_timeframe?: string | null
          canonical_dealing_range_version?: string | null
          close_reason?: string | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
          cross_tf_context_version?: string | null
          cross_tf_effective_mode?: string | null
          cross_tf_entry_allowed?: boolean | null
          cross_tf_entry_authority?: Json | null
          cross_tf_relationship?: string | null
          cross_tf_timeframe_evidence_id?: string | null
          current_price?: number | null
          current_price_old?: string | null
          decision_context?: Json | null
          direction: string
          direction_verdict?: Json | null
          direction_verdict_id?: string | null
          entry_confirmation?: Json | null
          entry_price?: number | null
          entry_price_old?: string | null
          final_authorization?: Json | null
          frozen_strategy_context?: Json | null
          frozen_strategy_hash?: string | null
          game_plan_id?: string | null
          game_plan_version?: string | null
          id?: string
          impulse_entry_lifecycle?: Json | null
          impulse_entry_lifecycle_id?: string | null
          mirrored_connection_ids?: string[]
          open_time: string
          order_id: string
          order_type?: string | null
          originating_zone?: Json | null
          partial_tp_fired?: boolean
          policy_frozen_at?: string | null
          position_id: string
          position_status?: string
          signal_reason?: string | null
          signal_score?: string
          size?: number | null
          size_old?: string | null
          source_candidate_key?: string | null
          source_pending_order_id?: string | null
          staged_setup_id?: string | null
          stop_loss?: number | null
          stop_loss_old?: string | null
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          symbol: string
          take_profit?: number | null
          take_profit_old?: string | null
          thesis_validation?: Json | null
          thesis_version?: string | null
          trade_overrides?: Json | null
          trigger_price?: string | null
          user_id: string
        }
        Update: {
          bot_id?: string | null
          broker_close_error?: string | null
          broker_close_state?: string
          broker_execution_error?: string | null
          broker_execution_state?: string
          broker_execution_updated_at?: string | null
          candidate_id?: string | null
          canonical_dealing_range?: Json | null
          canonical_dealing_range_impulse_id?: string | null
          canonical_dealing_range_timeframe?: string | null
          canonical_dealing_range_version?: string | null
          close_reason?: string | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
          cross_tf_context_version?: string | null
          cross_tf_effective_mode?: string | null
          cross_tf_entry_allowed?: boolean | null
          cross_tf_entry_authority?: Json | null
          cross_tf_relationship?: string | null
          cross_tf_timeframe_evidence_id?: string | null
          current_price?: number | null
          current_price_old?: string | null
          decision_context?: Json | null
          direction?: string
          direction_verdict?: Json | null
          direction_verdict_id?: string | null
          entry_confirmation?: Json | null
          entry_price?: number | null
          entry_price_old?: string | null
          final_authorization?: Json | null
          frozen_strategy_context?: Json | null
          frozen_strategy_hash?: string | null
          game_plan_id?: string | null
          game_plan_version?: string | null
          id?: string
          impulse_entry_lifecycle?: Json | null
          impulse_entry_lifecycle_id?: string | null
          mirrored_connection_ids?: string[]
          open_time?: string
          order_id?: string
          order_type?: string | null
          originating_zone?: Json | null
          partial_tp_fired?: boolean
          policy_frozen_at?: string | null
          position_id?: string
          position_status?: string
          signal_reason?: string | null
          signal_score?: string
          size?: number | null
          size_old?: string | null
          source_candidate_key?: string | null
          source_pending_order_id?: string | null
          staged_setup_id?: string | null
          stop_loss?: number | null
          stop_loss_old?: string | null
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          symbol?: string
          take_profit?: number | null
          take_profit_old?: string | null
          thesis_validation?: Json | null
          thesis_version?: string | null
          trade_overrides?: Json | null
          trigger_price?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_positions_direction_verdict_id_fkey"
            columns: ["direction_verdict_id"]
            isOneToOne: false
            referencedRelation: "active_direction_verdicts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_positions_game_plan_id_fkey"
            columns: ["game_plan_id"]
            isOneToOne: false
            referencedRelation: "active_game_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_positions_impulse_entry_lifecycle_id_fkey"
            columns: ["impulse_entry_lifecycle_id"]
            isOneToOne: false
            referencedRelation: "impulse_entry_lifecycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_positions_staged_setup_id_fkey"
            columns: ["staged_setup_id"]
            isOneToOne: false
            referencedRelation: "staged_setups"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_trade_history: {
        Row: {
          bot_id: string | null
          close_reason: string
          closed_at: string
          created_at: string
          direction: string
          entry_price: number | null
          entry_price_old: string | null
          exit_price: number | null
          exit_price_old: string | null
          id: string
          open_time: string
          order_id: string
          pnl: number | null
          pnl_old: string | null
          pnl_pips: number | null
          pnl_pips_old: string | null
          position_id: string
          signal_reason: string | null
          signal_score: string
          size: number | null
          size_old: string | null
          stop_loss: string | null
          streamlined_decision_frozen_at: string | null
          streamlined_decision_latest: Json | null
          streamlined_decision_origin: Json | null
          symbol: string
          take_profit: string | null
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          close_reason: string
          closed_at: string
          created_at?: string
          direction: string
          entry_price?: number | null
          entry_price_old?: string | null
          exit_price?: number | null
          exit_price_old?: string | null
          id?: string
          open_time: string
          order_id: string
          pnl?: number | null
          pnl_old?: string | null
          pnl_pips?: number | null
          pnl_pips_old?: string | null
          position_id: string
          signal_reason?: string | null
          signal_score?: string
          size?: number | null
          size_old?: string | null
          stop_loss?: string | null
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          symbol: string
          take_profit?: string | null
          user_id: string
        }
        Update: {
          bot_id?: string | null
          close_reason?: string
          closed_at?: string
          created_at?: string
          direction?: string
          entry_price?: number | null
          entry_price_old?: string | null
          exit_price?: number | null
          exit_price_old?: string | null
          id?: string
          open_time?: string
          order_id?: string
          pnl?: number | null
          pnl_old?: string | null
          pnl_pips?: number | null
          pnl_pips_old?: string | null
          position_id?: string
          signal_reason?: string | null
          signal_score?: string
          size?: number | null
          size_old?: string | null
          stop_loss?: string | null
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          symbol?: string
          take_profit?: string | null
          user_id?: string
        }
        Relationships: []
      }
      pending_orders: {
        Row: {
          bot_id: string
          cancel_reason: string | null
          candidate_id: string | null
          canonical_dealing_range: Json | null
          canonical_dealing_range_impulse_id: string | null
          canonical_dealing_range_timeframe: string | null
          canonical_dealing_range_version: string | null
          confirmation_attempts: number | null
          confirmation_config: Json
          confirmation_method: string | null
          created_at: string
          cross_tf_context_version: string | null
          cross_tf_effective_mode: string | null
          cross_tf_entry_allowed: boolean | null
          cross_tf_entry_authority: Json | null
          cross_tf_relationship: string | null
          cross_tf_timeframe_evidence_id: string | null
          current_price: number
          decision_context: Json | null
          direction: string
          direction_verdict: Json | null
          direction_verdict_id: string | null
          entry_confirmation: Json | null
          entry_price: number
          entry_zone_high: number | null
          entry_zone_low: number | null
          entry_zone_type: string | null
          exit_flags: Json | null
          expires_at: string
          expiry_minutes: number
          fill_reason: string | null
          filled_at: string | null
          final_authorization: Json | null
          from_watchlist: boolean
          frozen_strategy_context: Json | null
          frozen_strategy_hash: string | null
          game_plan_id: string | null
          game_plan_version: string | null
          id: string
          impulse_entry_lifecycle: Json | null
          impulse_entry_lifecycle_id: string | null
          last_confirmation_checked_at: string | null
          order_id: string
          order_type: string
          originating_zone: Json | null
          placed_at: string
          policy_frozen_at: string | null
          post_confirmation_entry: Json | null
          post_confirmation_observation: Json | null
          refined_zone_high: number | null
          refined_zone_low: number | null
          resolved_at: string | null
          setup_confidence: number | null
          setup_type: string | null
          signal_reason: Json | null
          signal_score: number | null
          size: number
          staged_cycles: number | null
          staged_initial_score: number | null
          staged_setup_id: string | null
          status: string
          stop_loss: number
          streamlined_decision_frozen_at: string | null
          streamlined_decision_latest: Json | null
          streamlined_decision_origin: Json | null
          style_base_policy_hash: string | null
          style_policy: Json | null
          style_policy_hash: string | null
          style_policy_version: string | null
          symbol: string
          take_profit: number
          thesis_cancel_reason: string | null
          thesis_validation: Json | null
          thesis_version: string | null
          updated_at: string
          user_id: string
          zone_touch_time: string | null
        }
        Insert: {
          bot_id?: string
          cancel_reason?: string | null
          candidate_id?: string | null
          canonical_dealing_range?: Json | null
          canonical_dealing_range_impulse_id?: string | null
          canonical_dealing_range_timeframe?: string | null
          canonical_dealing_range_version?: string | null
          confirmation_attempts?: number | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
          cross_tf_context_version?: string | null
          cross_tf_effective_mode?: string | null
          cross_tf_entry_allowed?: boolean | null
          cross_tf_entry_authority?: Json | null
          cross_tf_relationship?: string | null
          cross_tf_timeframe_evidence_id?: string | null
          current_price: number
          decision_context?: Json | null
          direction: string
          direction_verdict?: Json | null
          direction_verdict_id?: string | null
          entry_confirmation?: Json | null
          entry_price: number
          entry_zone_high?: number | null
          entry_zone_low?: number | null
          entry_zone_type?: string | null
          exit_flags?: Json | null
          expires_at: string
          expiry_minutes?: number
          fill_reason?: string | null
          filled_at?: string | null
          final_authorization?: Json | null
          from_watchlist?: boolean
          frozen_strategy_context?: Json | null
          frozen_strategy_hash?: string | null
          game_plan_id?: string | null
          game_plan_version?: string | null
          id?: string
          impulse_entry_lifecycle?: Json | null
          impulse_entry_lifecycle_id?: string | null
          last_confirmation_checked_at?: string | null
          order_id: string
          order_type?: string
          originating_zone?: Json | null
          placed_at?: string
          policy_frozen_at?: string | null
          post_confirmation_entry?: Json | null
          post_confirmation_observation?: Json | null
          refined_zone_high?: number | null
          refined_zone_low?: number | null
          resolved_at?: string | null
          setup_confidence?: number | null
          setup_type?: string | null
          signal_reason?: Json | null
          signal_score?: number | null
          size: number
          staged_cycles?: number | null
          staged_initial_score?: number | null
          staged_setup_id?: string | null
          status?: string
          stop_loss: number
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          symbol: string
          take_profit: number
          thesis_cancel_reason?: string | null
          thesis_validation?: Json | null
          thesis_version?: string | null
          updated_at?: string
          user_id: string
          zone_touch_time?: string | null
        }
        Update: {
          bot_id?: string
          cancel_reason?: string | null
          candidate_id?: string | null
          canonical_dealing_range?: Json | null
          canonical_dealing_range_impulse_id?: string | null
          canonical_dealing_range_timeframe?: string | null
          canonical_dealing_range_version?: string | null
          confirmation_attempts?: number | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
          cross_tf_context_version?: string | null
          cross_tf_effective_mode?: string | null
          cross_tf_entry_allowed?: boolean | null
          cross_tf_entry_authority?: Json | null
          cross_tf_relationship?: string | null
          cross_tf_timeframe_evidence_id?: string | null
          current_price?: number
          decision_context?: Json | null
          direction?: string
          direction_verdict?: Json | null
          direction_verdict_id?: string | null
          entry_confirmation?: Json | null
          entry_price?: number
          entry_zone_high?: number | null
          entry_zone_low?: number | null
          entry_zone_type?: string | null
          exit_flags?: Json | null
          expires_at?: string
          expiry_minutes?: number
          fill_reason?: string | null
          filled_at?: string | null
          final_authorization?: Json | null
          from_watchlist?: boolean
          frozen_strategy_context?: Json | null
          frozen_strategy_hash?: string | null
          game_plan_id?: string | null
          game_plan_version?: string | null
          id?: string
          impulse_entry_lifecycle?: Json | null
          impulse_entry_lifecycle_id?: string | null
          last_confirmation_checked_at?: string | null
          order_id?: string
          order_type?: string
          originating_zone?: Json | null
          placed_at?: string
          policy_frozen_at?: string | null
          post_confirmation_entry?: Json | null
          post_confirmation_observation?: Json | null
          refined_zone_high?: number | null
          refined_zone_low?: number | null
          resolved_at?: string | null
          setup_confidence?: number | null
          setup_type?: string | null
          signal_reason?: Json | null
          signal_score?: number | null
          size?: number
          staged_cycles?: number | null
          staged_initial_score?: number | null
          staged_setup_id?: string | null
          status?: string
          stop_loss?: number
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          symbol?: string
          take_profit?: number
          thesis_cancel_reason?: string | null
          thesis_validation?: Json | null
          thesis_version?: string | null
          updated_at?: string
          user_id?: string
          zone_touch_time?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pending_orders_direction_verdict_id_fkey"
            columns: ["direction_verdict_id"]
            isOneToOne: false
            referencedRelation: "active_direction_verdicts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_orders_game_plan_id_fkey"
            columns: ["game_plan_id"]
            isOneToOne: false
            referencedRelation: "active_game_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_orders_impulse_entry_lifecycle_id_fkey"
            columns: ["impulse_entry_lifecycle_id"]
            isOneToOne: false
            referencedRelation: "impulse_entry_lifecycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_orders_staged_setup_id_fkey"
            columns: ["staged_setup_id"]
            isOneToOne: false
            referencedRelation: "staged_setups"
            referencedColumns: ["id"]
          },
        ]
      }
      prop_firm_config: {
        Row: {
          account_currency: string
          account_stage: string
          best_day_rule_pct: number | null
          bot_id: string
          close_on_breach: boolean
          created_at: string
          day_reset_hour_utc: number
          emergency_close_pct: number
          firm_type: string
          id: string
          initial_balance: number
          is_active: boolean
          max_daily_loss_pct: number
          max_overall_loss_pct: number
          profit_target_pct: number | null
          reduce_size_near_limit: boolean
          safety_buffer_pct: number
          size_reduction_threshold_pct: number
          trailing_drawdown: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          account_currency?: string
          account_stage?: string
          best_day_rule_pct?: number | null
          bot_id?: string
          close_on_breach?: boolean
          created_at?: string
          day_reset_hour_utc?: number
          emergency_close_pct?: number
          firm_type?: string
          id?: string
          initial_balance?: number
          is_active?: boolean
          max_daily_loss_pct?: number
          max_overall_loss_pct?: number
          profit_target_pct?: number | null
          reduce_size_near_limit?: boolean
          safety_buffer_pct?: number
          size_reduction_threshold_pct?: number
          trailing_drawdown?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          account_currency?: string
          account_stage?: string
          best_day_rule_pct?: number | null
          bot_id?: string
          close_on_breach?: boolean
          created_at?: string
          day_reset_hour_utc?: number
          emergency_close_pct?: number
          firm_type?: string
          id?: string
          initial_balance?: number
          is_active?: boolean
          max_daily_loss_pct?: number
          max_overall_loss_pct?: number
          profit_target_pct?: number | null
          reduce_size_near_limit?: boolean
          safety_buffer_pct?: number
          size_reduction_threshold_pct?: number
          trailing_drawdown?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      prop_firm_daily_state: {
        Row: {
          config_id: string
          created_at: string
          current_equity: number | null
          day_start_balance: number
          day_start_equity: number
          end_of_day_balance: number | null
          highest_eod_balance_ever: number
          highest_equity_today: number
          id: string
          is_locked: boolean
          lock_reason: string | null
          locked_at: string | null
          lowest_equity_today: number
          realized_pnl_today: number
          trade_count_today: number
          trading_day: string
        }
        Insert: {
          config_id: string
          created_at?: string
          current_equity?: number | null
          day_start_balance: number
          day_start_equity: number
          end_of_day_balance?: number | null
          highest_eod_balance_ever: number
          highest_equity_today: number
          id?: string
          is_locked?: boolean
          lock_reason?: string | null
          locked_at?: string | null
          lowest_equity_today: number
          realized_pnl_today?: number
          trade_count_today?: number
          trading_day: string
        }
        Update: {
          config_id?: string
          created_at?: string
          current_equity?: number | null
          day_start_balance?: number
          day_start_equity?: number
          end_of_day_balance?: number | null
          highest_eod_balance_ever?: number
          highest_equity_today?: number
          id?: string
          is_locked?: boolean
          lock_reason?: string | null
          locked_at?: string | null
          lowest_equity_today?: number
          realized_pnl_today?: number
          trade_count_today?: number
          trading_day?: string
        }
        Relationships: [
          {
            foreignKeyName: "prop_firm_daily_state_config_id_fkey"
            columns: ["config_id"]
            isOneToOne: false
            referencedRelation: "prop_firm_config"
            referencedColumns: ["id"]
          },
        ]
      }
      prop_firm_events: {
        Row: {
          balance_at_event: number | null
          config_id: string
          created_at: string
          daily_loss_at_event: number | null
          details: Json | null
          drawdown_at_event: number | null
          equity_at_event: number | null
          event_type: string
          id: string
          message: string
          severity: string
        }
        Insert: {
          balance_at_event?: number | null
          config_id: string
          created_at?: string
          daily_loss_at_event?: number | null
          details?: Json | null
          drawdown_at_event?: number | null
          equity_at_event?: number | null
          event_type: string
          id?: string
          message: string
          severity: string
        }
        Update: {
          balance_at_event?: number | null
          config_id?: string
          created_at?: string
          daily_loss_at_event?: number | null
          details?: Json | null
          drawdown_at_event?: number | null
          equity_at_event?: number | null
          event_type?: string
          id?: string
          message?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "prop_firm_events_config_id_fkey"
            columns: ["config_id"]
            isOneToOne: false
            referencedRelation: "prop_firm_config"
            referencedColumns: ["id"]
          },
        ]
      }
      rejected_setups: {
        Row: {
          bot_id: string
          confluence_score: number
          created_at: string
          decision_outcome_snapshot: Json | null
          direction: string
          entry_price: number
          failed_gates: string[] | null
          fotsi_base_tsi: number | null
          fotsi_quote_tsi: number | null
          gp_bias: string | null
          gp_bias_confidence: number | null
          id: string
          mae_pips: number | null
          mae_r: number | null
          mfe_pips: number | null
          mfe_r: number | null
          normalized_gates: string[]
          opportunity_key: string | null
          outcome_checked_at: string | null
          outcome_contract_version: string | null
          outcome_r: number | null
          outcome_reason: string | null
          outcome_status: string
          outcome_window_hours: number | null
          price_at_rejection: number | null
          price_reached_entry: boolean | null
          raw_detail: Json | null
          regime: string | null
          rejected_at: string
          rejection_type: string
          rr_ratio: number | null
          session_name: string | null
          shadow_decision: Json | null
          sl_hit: boolean | null
          sl_hit_time_minutes: number | null
          stop_loss: number | null
          streamlined_decision_frozen_at: string | null
          streamlined_decision_latest: Json | null
          streamlined_decision_origin: Json | null
          symbol: string
          take_profit: number | null
          tier1_count: number
          tier1_factors: string[] | null
          tp_hit: boolean | null
          tp_hit_time_minutes: number | null
          user_id: string
        }
        Insert: {
          bot_id?: string
          confluence_score: number
          created_at?: string
          decision_outcome_snapshot?: Json | null
          direction: string
          entry_price: number
          failed_gates?: string[] | null
          fotsi_base_tsi?: number | null
          fotsi_quote_tsi?: number | null
          gp_bias?: string | null
          gp_bias_confidence?: number | null
          id?: string
          mae_pips?: number | null
          mae_r?: number | null
          mfe_pips?: number | null
          mfe_r?: number | null
          normalized_gates?: string[]
          opportunity_key?: string | null
          outcome_checked_at?: string | null
          outcome_contract_version?: string | null
          outcome_r?: number | null
          outcome_reason?: string | null
          outcome_status?: string
          outcome_window_hours?: number | null
          price_at_rejection?: number | null
          price_reached_entry?: boolean | null
          raw_detail?: Json | null
          regime?: string | null
          rejected_at?: string
          rejection_type: string
          rr_ratio?: number | null
          session_name?: string | null
          shadow_decision?: Json | null
          sl_hit?: boolean | null
          sl_hit_time_minutes?: number | null
          stop_loss?: number | null
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          symbol: string
          take_profit?: number | null
          tier1_count?: number
          tier1_factors?: string[] | null
          tp_hit?: boolean | null
          tp_hit_time_minutes?: number | null
          user_id: string
        }
        Update: {
          bot_id?: string
          confluence_score?: number
          created_at?: string
          decision_outcome_snapshot?: Json | null
          direction?: string
          entry_price?: number
          failed_gates?: string[] | null
          fotsi_base_tsi?: number | null
          fotsi_quote_tsi?: number | null
          gp_bias?: string | null
          gp_bias_confidence?: number | null
          id?: string
          mae_pips?: number | null
          mae_r?: number | null
          mfe_pips?: number | null
          mfe_r?: number | null
          normalized_gates?: string[]
          opportunity_key?: string | null
          outcome_checked_at?: string | null
          outcome_contract_version?: string | null
          outcome_r?: number | null
          outcome_reason?: string | null
          outcome_status?: string
          outcome_window_hours?: number | null
          price_at_rejection?: number | null
          price_reached_entry?: boolean | null
          raw_detail?: Json | null
          regime?: string | null
          rejected_at?: string
          rejection_type?: string
          rr_ratio?: number | null
          session_name?: string | null
          shadow_decision?: Json | null
          sl_hit?: boolean | null
          sl_hit_time_minutes?: number | null
          stop_loss?: number | null
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          symbol?: string
          take_profit?: number | null
          tier1_count?: number
          tier1_factors?: string[] | null
          tp_hit?: boolean | null
          tp_hit_time_minutes?: number | null
          user_id?: string
        }
        Relationships: []
      }
      scan_candle_snapshots: {
        Row: {
          bot_id: string
          candle_count: number
          candles: Json
          completed_candle_cutoff: string | null
          contract_version: string
          created_at: string
          id: string
          observed_at: string
          provider: string
          scan_cycle_id: string
          symbol: string
          timeframe: string
          user_id: string
        }
        Insert: {
          bot_id: string
          candle_count: number
          candles: Json
          completed_candle_cutoff?: string | null
          contract_version?: string
          created_at?: string
          id?: string
          observed_at: string
          provider: string
          scan_cycle_id: string
          symbol: string
          timeframe: string
          user_id: string
        }
        Update: {
          bot_id?: string
          candle_count?: number
          candles?: Json
          completed_candle_cutoff?: string | null
          contract_version?: string
          created_at?: string
          id?: string
          observed_at?: string
          provider?: string
          scan_cycle_id?: string
          symbol?: string
          timeframe?: string
          user_id?: string
        }
        Relationships: []
      }
      scan_history: {
        Row: {
          bot_id: string | null
          created_at: string | null
          id: string
          payload: Json
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          created_at?: string | null
          id?: string
          payload?: Json
          user_id: string
        }
        Update: {
          bot_id?: string | null
          created_at?: string | null
          id?: string
          payload?: Json
          user_id?: string
        }
        Relationships: []
      }
      scan_logs: {
        Row: {
          bot_id: string
          created_at: string
          details_json: Json | null
          id: string
          pairs_scanned: number
          scanned_at: string
          signals_found: number
          trades_placed: number
          user_id: string
        }
        Insert: {
          bot_id?: string
          created_at?: string
          details_json?: Json | null
          id?: string
          pairs_scanned?: number
          scanned_at?: string
          signals_found?: number
          trades_placed?: number
          user_id: string
        }
        Update: {
          bot_id?: string
          created_at?: string
          details_json?: Json | null
          id?: string
          pairs_scanned?: number
          scanned_at?: string
          signals_found?: number
          trades_placed?: number
          user_id?: string
        }
        Relationships: []
      }
      scanner_authorization_failures: {
        Row: {
          function_name: string
          id: number
          occurred_at: string
          reason: string
          request_metadata: Json
        }
        Insert: {
          function_name: string
          id?: never
          occurred_at?: string
          reason: string
          request_metadata?: Json
        }
        Update: {
          function_name?: string
          id?: never
          occurred_at?: string
          reason?: string
          request_metadata?: Json
        }
        Relationships: []
      }
      scanner_health_monitor_state: {
        Row: {
          bot_id: string
          first_observed_at: string
          last_evaluated_at: string
          user_id: string
        }
        Insert: {
          bot_id: string
          first_observed_at?: string
          last_evaluated_at?: string
          user_id: string
        }
        Update: {
          bot_id?: string
          first_observed_at?: string
          last_evaluated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scanner_operation_runs: {
        Row: {
          bot_id: string
          created_at: string
          error_code: string | null
          error_message: string | null
          expected_pairs: number | null
          function_name: string
          heartbeat_at: string
          id: string
          invoked_at: string
          metadata: Json
          operation: string
          pair_processing_completed_at: string | null
          phase: string
          position_management_completed_at: string | null
          processed_pairs: number
          scan_completed_at: string | null
          scan_cycle_id: string | null
          scan_started_at: string | null
          status: string
          trigger_source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          bot_id?: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          expected_pairs?: number | null
          function_name: string
          heartbeat_at?: string
          id?: string
          invoked_at?: string
          metadata?: Json
          operation: string
          pair_processing_completed_at?: string | null
          phase?: string
          position_management_completed_at?: string | null
          processed_pairs?: number
          scan_completed_at?: string | null
          scan_cycle_id?: string | null
          scan_started_at?: string | null
          status?: string
          trigger_source: string
          updated_at?: string
          user_id: string
        }
        Update: {
          bot_id?: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          expected_pairs?: number | null
          function_name?: string
          heartbeat_at?: string
          id?: string
          invoked_at?: string
          metadata?: Json
          operation?: string
          pair_processing_completed_at?: string | null
          phase?: string
          position_management_completed_at?: string | null
          processed_pairs?: number
          scan_completed_at?: string | null
          scan_cycle_id?: string | null
          scan_started_at?: string | null
          status?: string
          trigger_source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scanner_operational_alerts: {
        Row: {
          alert_type: string
          bot_id: string
          created_at: string
          dedupe_key: string
          evidence: Json
          first_detected_at: string
          id: string
          last_detected_at: string
          message: string
          occurrences: number
          resolved_at: string | null
          run_id: string | null
          severity: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          alert_type: string
          bot_id?: string
          created_at?: string
          dedupe_key?: string
          evidence?: Json
          first_detected_at?: string
          id?: string
          last_detected_at?: string
          message: string
          occurrences?: number
          resolved_at?: string | null
          run_id?: string | null
          severity?: string
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          alert_type?: string
          bot_id?: string
          created_at?: string
          dedupe_key?: string
          evidence?: Json
          first_detected_at?: string
          id?: string
          last_detected_at?: string
          message?: string
          occurrences?: number
          resolved_at?: string | null
          run_id?: string | null
          severity?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scanner_runtime_locks: {
        Row: {
          acquired_at: string
          bot_id: string
          heartbeat_at: string
          lease_token: string
          lease_until: string
          lock_scope: string
          run_id: string | null
          user_id: string
        }
        Insert: {
          acquired_at?: string
          bot_id: string
          heartbeat_at?: string
          lease_token: string
          lease_until: string
          lock_scope: string
          run_id?: string | null
          user_id: string
        }
        Update: {
          acquired_at?: string
          bot_id?: string
          heartbeat_at?: string
          lease_token?: string
          lease_until?: string
          lock_scope?: string
          run_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      scheduled_tasks: {
        Row: {
          action: string
          category: string | null
          created_at: string | null
          cron_expression: string | null
          default_interval_minutes: number
          description: string | null
          display_name: string
          enabled: boolean | null
          function_name: string
          id: string
          interval_minutes: number
          last_error: string | null
          last_run_at: string | null
          last_status: string | null
          run_count: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          action: string
          category?: string | null
          created_at?: string | null
          cron_expression?: string | null
          default_interval_minutes: number
          description?: string | null
          display_name: string
          enabled?: boolean | null
          function_name: string
          id?: string
          interval_minutes: number
          last_error?: string | null
          last_run_at?: string | null
          last_status?: string | null
          run_count?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          action?: string
          category?: string | null
          created_at?: string | null
          cron_expression?: string | null
          default_interval_minutes?: number
          description?: string | null
          display_name?: string
          enabled?: boolean | null
          function_name?: string
          id?: string
          interval_minutes?: number
          last_error?: string | null
          last_run_at?: string | null
          last_status?: string | null
          run_count?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      setup_lifecycle_events: {
        Row: {
          bot_id: string
          candidate_id: string
          created_at: string
          direction: string
          evidence: Json
          from_status: string | null
          id: string
          lifecycle_phase: string | null
          reason: string | null
          reason_code: string | null
          staged_setup_id: string
          symbol: string
          to_status: string
          user_id: string
        }
        Insert: {
          bot_id: string
          candidate_id: string
          created_at?: string
          direction: string
          evidence?: Json
          from_status?: string | null
          id?: string
          lifecycle_phase?: string | null
          reason?: string | null
          reason_code?: string | null
          staged_setup_id: string
          symbol: string
          to_status: string
          user_id: string
        }
        Update: {
          bot_id?: string
          candidate_id?: string
          created_at?: string
          direction?: string
          evidence?: Json
          from_status?: string | null
          id?: string
          lifecycle_phase?: string | null
          reason?: string | null
          reason_code?: string | null
          staged_setup_id?: string
          symbol?: string
          to_status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "setup_lifecycle_events_staged_setup_id_fkey"
            columns: ["staged_setup_id"]
            isOneToOne: false
            referencedRelation: "staged_setups"
            referencedColumns: ["id"]
          },
        ]
      }
      staged_setups: {
        Row: {
          analysis_snapshot: Json | null
          authorization_result: Json | null
          bot_id: string
          candidate_id: string
          canonical_dealing_range: Json | null
          canonical_dealing_range_impulse_id: string | null
          canonical_dealing_range_timeframe: string | null
          canonical_dealing_range_version: string | null
          confirmation_config: Json
          confirmation_method: string | null
          created_at: string
          cross_tf_context_version: string | null
          cross_tf_effective_mode: string | null
          cross_tf_entry_allowed: boolean | null
          cross_tf_entry_authority: Json | null
          cross_tf_relationship: string | null
          cross_tf_timeframe_evidence_id: string | null
          current_factors: Json
          current_score: number
          direction: string
          direction_verdict: Json | null
          direction_verdict_id: string | null
          entry_price: number | null
          execution_eligible: boolean
          frozen_strategy_context: Json | null
          frozen_strategy_hash: string | null
          game_plan_id: string | null
          game_plan_version: string | null
          id: string
          impulse_entry_lifecycle: Json | null
          impulse_entry_lifecycle_id: string | null
          initial_factors: Json
          initial_score: number
          invalidation_reason: string | null
          last_eval_at: string
          lifecycle_evidence: Json
          lifecycle_phase: string | null
          lifecycle_reason: string | null
          lifecycle_reason_code: string | null
          lifecycle_version: string
          min_cycles: number
          missing_factors: Json
          observation_parent_id: string | null
          observation_reason: string | null
          originating_zone: Json | null
          pending_order_id: string | null
          policy_frozen_at: string | null
          position_id: string | null
          promotion_reason: string | null
          qualified_at: string | null
          resolved_at: string | null
          scan_cycles: number
          setup_type: string | null
          sl_level: number | null
          staged_at: string
          status: string
          streamlined_decision_frozen_at: string | null
          streamlined_decision_latest: Json | null
          streamlined_decision_origin: Json | null
          style_base_policy_hash: string | null
          style_policy: Json | null
          style_policy_hash: string | null
          style_policy_version: string | null
          symbol: string
          thesis_version: string | null
          tier1_count: number
          tier2_count: number
          tier3_count: number
          tp_level: number | null
          ttl_minutes: number
          updated_at: string
          user_id: string
          watch_threshold: number
        }
        Insert: {
          analysis_snapshot?: Json | null
          authorization_result?: Json | null
          bot_id?: string
          candidate_id?: string
          canonical_dealing_range?: Json | null
          canonical_dealing_range_impulse_id?: string | null
          canonical_dealing_range_timeframe?: string | null
          canonical_dealing_range_version?: string | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
          cross_tf_context_version?: string | null
          cross_tf_effective_mode?: string | null
          cross_tf_entry_allowed?: boolean | null
          cross_tf_entry_authority?: Json | null
          cross_tf_relationship?: string | null
          cross_tf_timeframe_evidence_id?: string | null
          current_factors?: Json
          current_score: number
          direction: string
          direction_verdict?: Json | null
          direction_verdict_id?: string | null
          entry_price?: number | null
          execution_eligible?: boolean
          frozen_strategy_context?: Json | null
          frozen_strategy_hash?: string | null
          game_plan_id?: string | null
          game_plan_version?: string | null
          id?: string
          impulse_entry_lifecycle?: Json | null
          impulse_entry_lifecycle_id?: string | null
          initial_factors?: Json
          initial_score: number
          invalidation_reason?: string | null
          last_eval_at?: string
          lifecycle_evidence?: Json
          lifecycle_phase?: string | null
          lifecycle_reason?: string | null
          lifecycle_reason_code?: string | null
          lifecycle_version?: string
          min_cycles?: number
          missing_factors?: Json
          observation_parent_id?: string | null
          observation_reason?: string | null
          originating_zone?: Json | null
          pending_order_id?: string | null
          policy_frozen_at?: string | null
          position_id?: string | null
          promotion_reason?: string | null
          qualified_at?: string | null
          resolved_at?: string | null
          scan_cycles?: number
          setup_type?: string | null
          sl_level?: number | null
          staged_at?: string
          status?: string
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          symbol: string
          thesis_version?: string | null
          tier1_count?: number
          tier2_count?: number
          tier3_count?: number
          tp_level?: number | null
          ttl_minutes?: number
          updated_at?: string
          user_id: string
          watch_threshold: number
        }
        Update: {
          analysis_snapshot?: Json | null
          authorization_result?: Json | null
          bot_id?: string
          candidate_id?: string
          canonical_dealing_range?: Json | null
          canonical_dealing_range_impulse_id?: string | null
          canonical_dealing_range_timeframe?: string | null
          canonical_dealing_range_version?: string | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
          cross_tf_context_version?: string | null
          cross_tf_effective_mode?: string | null
          cross_tf_entry_allowed?: boolean | null
          cross_tf_entry_authority?: Json | null
          cross_tf_relationship?: string | null
          cross_tf_timeframe_evidence_id?: string | null
          current_factors?: Json
          current_score?: number
          direction?: string
          direction_verdict?: Json | null
          direction_verdict_id?: string | null
          entry_price?: number | null
          execution_eligible?: boolean
          frozen_strategy_context?: Json | null
          frozen_strategy_hash?: string | null
          game_plan_id?: string | null
          game_plan_version?: string | null
          id?: string
          impulse_entry_lifecycle?: Json | null
          impulse_entry_lifecycle_id?: string | null
          initial_factors?: Json
          initial_score?: number
          invalidation_reason?: string | null
          last_eval_at?: string
          lifecycle_evidence?: Json
          lifecycle_phase?: string | null
          lifecycle_reason?: string | null
          lifecycle_reason_code?: string | null
          lifecycle_version?: string
          min_cycles?: number
          missing_factors?: Json
          observation_parent_id?: string | null
          observation_reason?: string | null
          originating_zone?: Json | null
          pending_order_id?: string | null
          policy_frozen_at?: string | null
          position_id?: string | null
          promotion_reason?: string | null
          qualified_at?: string | null
          resolved_at?: string | null
          scan_cycles?: number
          setup_type?: string | null
          sl_level?: number | null
          staged_at?: string
          status?: string
          streamlined_decision_frozen_at?: string | null
          streamlined_decision_latest?: Json | null
          streamlined_decision_origin?: Json | null
          style_base_policy_hash?: string | null
          style_policy?: Json | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          symbol?: string
          thesis_version?: string | null
          tier1_count?: number
          tier2_count?: number
          tier3_count?: number
          tp_level?: number | null
          ttl_minutes?: number
          updated_at?: string
          user_id?: string
          watch_threshold?: number
        }
        Relationships: [
          {
            foreignKeyName: "staged_setups_direction_verdict_id_fkey"
            columns: ["direction_verdict_id"]
            isOneToOne: false
            referencedRelation: "active_direction_verdicts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staged_setups_game_plan_id_fkey"
            columns: ["game_plan_id"]
            isOneToOne: false
            referencedRelation: "active_game_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staged_setups_impulse_entry_lifecycle_id_fkey"
            columns: ["impulse_entry_lifecycle_id"]
            isOneToOne: false
            referencedRelation: "impulse_entry_lifecycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staged_setups_observation_parent_id_fkey"
            columns: ["observation_parent_id"]
            isOneToOne: false
            referencedRelation: "staged_setups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staged_setups_pending_order_id_fkey"
            columns: ["pending_order_id"]
            isOneToOne: false
            referencedRelation: "pending_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staged_setups_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "paper_positions"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_activation_events: {
        Row: {
          activation_id: string
          actor_id: string | null
          bot_id: string
          created_at: string
          evidence_contract_version: string
          evidence_hash: string
          evidence_snapshot: Json
          feature_key: string
          from_authority_stage: string | null
          from_runtime_scope: string | null
          id: string
          reason: string
          revision: number
          to_authority_stage: string
          to_runtime_scope: string
          user_id: string
          variant_key: string
        }
        Insert: {
          activation_id: string
          actor_id?: string | null
          bot_id: string
          created_at?: string
          evidence_contract_version: string
          evidence_hash: string
          evidence_snapshot: Json
          feature_key: string
          from_authority_stage?: string | null
          from_runtime_scope?: string | null
          id?: string
          reason: string
          revision: number
          to_authority_stage: string
          to_runtime_scope: string
          user_id: string
          variant_key: string
        }
        Update: {
          activation_id?: string
          actor_id?: string | null
          bot_id?: string
          created_at?: string
          evidence_contract_version?: string
          evidence_hash?: string
          evidence_snapshot?: Json
          feature_key?: string
          from_authority_stage?: string | null
          from_runtime_scope?: string | null
          id?: string
          reason?: string
          revision?: number
          to_authority_stage?: string
          to_runtime_scope?: string
          user_id?: string
          variant_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_activation_events_activation_id_fkey"
            columns: ["activation_id"]
            isOneToOne: false
            referencedRelation: "strategy_activation_registry"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_activation_registry: {
        Row: {
          activation_scope: Json
          activation_scope_hash: string
          approved_at: string | null
          approved_by: string | null
          authority_stage: string
          bot_id: string
          created_at: string
          evidence_contract_version: string
          evidence_hash: string
          evidence_snapshot: Json
          evidence_window_end: string | null
          evidence_window_start: string | null
          feature_key: string
          id: string
          revision: number
          runtime_enforced: boolean
          runtime_scope: string
          transition_reason: string | null
          updated_at: string
          user_id: string
          variant_key: string
        }
        Insert: {
          activation_scope?: Json
          activation_scope_hash: string
          approved_at?: string | null
          approved_by?: string | null
          authority_stage?: string
          bot_id?: string
          created_at?: string
          evidence_contract_version?: string
          evidence_hash: string
          evidence_snapshot?: Json
          evidence_window_end?: string | null
          evidence_window_start?: string | null
          feature_key: string
          id?: string
          revision?: number
          runtime_enforced?: boolean
          runtime_scope?: string
          transition_reason?: string | null
          updated_at?: string
          user_id: string
          variant_key?: string
        }
        Update: {
          activation_scope?: Json
          activation_scope_hash?: string
          approved_at?: string | null
          approved_by?: string | null
          authority_stage?: string
          bot_id?: string
          created_at?: string
          evidence_contract_version?: string
          evidence_hash?: string
          evidence_snapshot?: Json
          evidence_window_end?: string | null
          evidence_window_start?: string | null
          feature_key?: string
          id?: string
          revision?: number
          runtime_enforced?: boolean
          runtime_scope?: string
          transition_reason?: string | null
          updated_at?: string
          user_id?: string
          variant_key?: string
        }
        Relationships: []
      }
      strategy_evidence_certificates: {
        Row: {
          activation_scope: Json
          activation_scope_hash: string
          beneficial_rate_percent: number | null
          bot_id: string
          certificate: Json
          certificate_hash: string
          changed_count: number
          contract_version: string
          coverage_percent: number
          created_at: string
          evidence_count: number
          expectancy_delta_r: number
          feature_key: string
          generated_at: string
          generator_version: string
          good_trade_retention_percent: number
          id: string
          is_current: boolean
          max_drawdown_delta_percent: number
          out_of_sample_passed: boolean
          resolved_count: number
          source_window_end: string | null
          source_window_start: string | null
          status: string
          superseded_at: string | null
          total_candidates: number
          user_id: string
          variant_key: string
          walk_forward_consistent: boolean
        }
        Insert: {
          activation_scope?: Json
          activation_scope_hash: string
          beneficial_rate_percent?: number | null
          bot_id?: string
          certificate: Json
          certificate_hash: string
          changed_count: number
          contract_version?: string
          coverage_percent: number
          created_at?: string
          evidence_count: number
          expectancy_delta_r: number
          feature_key: string
          generated_at: string
          generator_version: string
          good_trade_retention_percent: number
          id?: string
          is_current?: boolean
          max_drawdown_delta_percent: number
          out_of_sample_passed: boolean
          resolved_count: number
          source_window_end?: string | null
          source_window_start?: string | null
          status: string
          superseded_at?: string | null
          total_candidates: number
          user_id: string
          variant_key?: string
          walk_forward_consistent: boolean
        }
        Update: {
          activation_scope?: Json
          activation_scope_hash?: string
          beneficial_rate_percent?: number | null
          bot_id?: string
          certificate?: Json
          certificate_hash?: string
          changed_count?: number
          contract_version?: string
          coverage_percent?: number
          created_at?: string
          evidence_count?: number
          expectancy_delta_r?: number
          feature_key?: string
          generated_at?: string
          generator_version?: string
          good_trade_retention_percent?: number
          id?: string
          is_current?: boolean
          max_drawdown_delta_percent?: number
          out_of_sample_passed?: boolean
          resolved_count?: number
          source_window_end?: string | null
          source_window_start?: string | null
          status?: string
          superseded_at?: string | null
          total_candidates?: number
          user_id?: string
          variant_key?: string
          walk_forward_consistent?: boolean
        }
        Relationships: []
      }
      streamlined_decision_certificates: {
        Row: {
          certified: boolean
          comparable: number
          created_at: string
          evidence: Json
          expires_at: string
          id: string
          minimum_comparable: number
          runtime_targets: string[]
          styles: string[]
          user_id: string
        }
        Insert: {
          certified?: boolean
          comparable?: number
          created_at?: string
          evidence?: Json
          expires_at: string
          id?: string
          minimum_comparable?: number
          runtime_targets?: string[]
          styles?: string[]
          user_id: string
        }
        Update: {
          certified?: boolean
          comparable?: number
          created_at?: string
          evidence?: Json
          expires_at?: string
          id?: string
          minimum_comparable?: number
          runtime_targets?: string[]
          styles?: string[]
          user_id?: string
        }
        Relationships: []
      }
      telegram_notification_claims: {
        Row: {
          claim_key: string
          created_at: string
          expires_at: string
        }
        Insert: {
          claim_key: string
          created_at?: string
          expires_at: string
        }
        Update: {
          claim_key?: string
          created_at?: string
          expires_at?: string
        }
        Relationships: []
      }
      trade_archive: {
        Row: {
          archived_at: string | null
          bot_id: string | null
          close_reason: string | null
          closed_at: string | null
          created_at: string | null
          direction: string
          entry_price: string | null
          exit_price: string | null
          id: string
          open_time: string | null
          order_id: string | null
          pnl: string | null
          pnl_pips: string | null
          signal_reason: string | null
          signal_score: string | null
          size: string | null
          symbol: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          bot_id?: string | null
          close_reason?: string | null
          closed_at?: string | null
          created_at?: string | null
          direction: string
          entry_price?: string | null
          exit_price?: string | null
          id: string
          open_time?: string | null
          order_id?: string | null
          pnl?: string | null
          pnl_pips?: string | null
          signal_reason?: string | null
          signal_score?: string | null
          size?: string | null
          symbol: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          bot_id?: string | null
          close_reason?: string | null
          closed_at?: string | null
          created_at?: string | null
          direction?: string
          entry_price?: string | null
          exit_price?: string | null
          id?: string
          open_time?: string | null
          order_id?: string | null
          pnl?: string | null
          pnl_pips?: string | null
          signal_reason?: string | null
          signal_score?: string | null
          size?: string | null
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      trade_post_mortems: {
        Row: {
          created_at: string
          detail_json: Json | null
          exit_price: string | null
          exit_reason: string
          id: string
          lesson_learned: string | null
          pnl: string | null
          position_id: string
          symbol: string
          trade_id: string | null
          user_id: string
          what_failed: string | null
          what_worked: string | null
        }
        Insert: {
          created_at?: string
          detail_json?: Json | null
          exit_price?: string | null
          exit_reason: string
          id?: string
          lesson_learned?: string | null
          pnl?: string | null
          position_id: string
          symbol: string
          trade_id?: string | null
          user_id: string
          what_failed?: string | null
          what_worked?: string | null
        }
        Update: {
          created_at?: string
          detail_json?: Json | null
          exit_price?: string | null
          exit_reason?: string
          id?: string
          lesson_learned?: string | null
          pnl?: string | null
          position_id?: string
          symbol?: string
          trade_id?: string | null
          user_id?: string
          what_failed?: string | null
          what_worked?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trade_post_mortems_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_reasonings: {
        Row: {
          bias: string | null
          confluence_score: number
          created_at: string
          direction: string
          factors_json: Json | null
          id: string
          position_id: string
          session: string | null
          summary: string | null
          symbol: string
          timeframe: string | null
          trade_id: string | null
          user_id: string
        }
        Insert: {
          bias?: string | null
          confluence_score: number
          created_at?: string
          direction: string
          factors_json?: Json | null
          id?: string
          position_id: string
          session?: string | null
          summary?: string | null
          symbol: string
          timeframe?: string | null
          trade_id?: string | null
          user_id: string
        }
        Update: {
          bias?: string | null
          confluence_score?: number
          created_at?: string
          direction?: string
          factors_json?: Json | null
          id?: string
          position_id?: string
          session?: string | null
          summary?: string | null
          symbol?: string
          timeframe?: string | null
          trade_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_reasonings_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_review_notes: {
        Row: {
          created_at: string
          id: string
          lesson: string | null
          notes: string | null
          position_id: string
          review_status: string
          reviewed_at: string | null
          tags: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          lesson?: string | null
          notes?: string | null
          position_id: string
          review_status?: string
          reviewed_at?: string | null
          tags?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          lesson?: string | null
          notes?: string | null
          position_id?: string
          review_status?: string
          reviewed_at?: string | null
          tags?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          confluence_score: number | null
          created_at: string
          deviations: string | null
          direction: string
          entry_price: number | null
          entry_price_old: string | null
          entry_time: string
          exit_price: number | null
          exit_price_old: string | null
          exit_time: string | null
          followed_strategy: boolean | null
          id: string
          improvements: string | null
          notes: string | null
          pnl_amount: number | null
          pnl_amount_old: string | null
          pnl_pips: number | null
          pnl_pips_old: string | null
          position_size: number | null
          position_size_old: string | null
          post_mortem_json: Json | null
          reasoning_json: Json | null
          risk_percent: number | null
          risk_percent_old: string | null
          risk_reward: number | null
          risk_reward_old: string | null
          screenshot_url: string | null
          setup_type: string | null
          status: string
          stop_loss: number | null
          stop_loss_old: string | null
          symbol: string
          take_profit: number | null
          take_profit_old: string | null
          timeframe: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          confluence_score?: number | null
          created_at?: string
          deviations?: string | null
          direction: string
          entry_price?: number | null
          entry_price_old?: string | null
          entry_time: string
          exit_price?: number | null
          exit_price_old?: string | null
          exit_time?: string | null
          followed_strategy?: boolean | null
          id?: string
          improvements?: string | null
          notes?: string | null
          pnl_amount?: number | null
          pnl_amount_old?: string | null
          pnl_pips?: number | null
          pnl_pips_old?: string | null
          position_size?: number | null
          position_size_old?: string | null
          post_mortem_json?: Json | null
          reasoning_json?: Json | null
          risk_percent?: number | null
          risk_percent_old?: string | null
          risk_reward?: number | null
          risk_reward_old?: string | null
          screenshot_url?: string | null
          setup_type?: string | null
          status?: string
          stop_loss?: number | null
          stop_loss_old?: string | null
          symbol: string
          take_profit?: number | null
          take_profit_old?: string | null
          timeframe?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          confluence_score?: number | null
          created_at?: string
          deviations?: string | null
          direction?: string
          entry_price?: number | null
          entry_price_old?: string | null
          entry_time?: string
          exit_price?: number | null
          exit_price_old?: string | null
          exit_time?: string | null
          followed_strategy?: boolean | null
          id?: string
          improvements?: string | null
          notes?: string | null
          pnl_amount?: number | null
          pnl_amount_old?: string | null
          pnl_pips?: number | null
          pnl_pips_old?: string | null
          position_size?: number | null
          position_size_old?: string | null
          post_mortem_json?: Json | null
          reasoning_json?: Json | null
          risk_percent?: number | null
          risk_percent_old?: string | null
          risk_reward?: number | null
          risk_reward_old?: string | null
          screenshot_url?: string | null
          setup_type?: string | null
          status?: string
          stop_loss?: number | null
          stop_loss_old?: string | null
          symbol?: string
          take_profit?: number | null
          take_profit_old?: string | null
          timeframe?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          created_at: string
          id: string
          preferences_json: Json | null
          risk_settings_json: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          preferences_json?: Json | null
          risk_settings_json?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          preferences_json?: Json | null
          risk_settings_json?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      zone_candidate_shadow_observations: {
        Row: {
          activation_eligible: boolean
          bot_id: string
          candidate_id: string
          candidate_lifecycle: Json | null
          candidate_lifecycle_state: string | null
          candidate_lineage: Json | null
          candidate_model: Json | null
          candidate_model_rank: number | null
          candidate_model_version: string | null
          candidate_model_winner: boolean
          created_at: string
          cross_tf_disagreed: boolean
          cross_tf_evaluation: Json | null
          cross_tf_policy: Json | null
          cross_tf_policy_version: string | null
          cross_tf_reason_codes: string[]
          cross_tf_shadow_decision: string | null
          direction: string
          entry_price: number
          evidence_source: string
          id: string
          legacy_comparable_score: number
          legacy_execution_decision: string | null
          legacy_rank: number
          legacy_winner: boolean
          legacy_zone_score: number
          local_confluence: Json
          mae_pips: number | null
          mfe_pips: number | null
          observed_at: string
          outcome_checked_at: string | null
          outcome_status: string
          parent_candidate_id: string | null
          price_reached_entry: boolean | null
          rank_delta: number
          ranking_disagreed: boolean
          replay_contract_version: string | null
          replay_run_id: string | null
          scan_cycle_id: string
          shadow_local_score: number
          shadow_rank: number
          shadow_ranking: Json
          shadow_winner: boolean
          sl_hit: boolean | null
          stop_loss: number | null
          style_base_policy_hash: string | null
          style_policy_hash: string | null
          style_policy_version: string | null
          symbol: string
          take_profit: number | null
          timeframe_relationship: string | null
          tp_hit: boolean | null
          tp_hit_time_minutes: number | null
          trading_style: string
          user_id: string
          zone_high: number
          zone_low: number
          zone_type: string
        }
        Insert: {
          activation_eligible?: boolean
          bot_id?: string
          candidate_id: string
          candidate_lifecycle?: Json | null
          candidate_lifecycle_state?: string | null
          candidate_lineage?: Json | null
          candidate_model?: Json | null
          candidate_model_rank?: number | null
          candidate_model_version?: string | null
          candidate_model_winner?: boolean
          created_at?: string
          cross_tf_disagreed?: boolean
          cross_tf_evaluation?: Json | null
          cross_tf_policy?: Json | null
          cross_tf_policy_version?: string | null
          cross_tf_reason_codes?: string[]
          cross_tf_shadow_decision?: string | null
          direction: string
          entry_price: number
          evidence_source?: string
          id?: string
          legacy_comparable_score: number
          legacy_execution_decision?: string | null
          legacy_rank: number
          legacy_winner?: boolean
          legacy_zone_score: number
          local_confluence: Json
          mae_pips?: number | null
          mfe_pips?: number | null
          observed_at?: string
          outcome_checked_at?: string | null
          outcome_status?: string
          parent_candidate_id?: string | null
          price_reached_entry?: boolean | null
          rank_delta: number
          ranking_disagreed?: boolean
          replay_contract_version?: string | null
          replay_run_id?: string | null
          scan_cycle_id: string
          shadow_local_score: number
          shadow_rank: number
          shadow_ranking: Json
          shadow_winner?: boolean
          sl_hit?: boolean | null
          stop_loss?: number | null
          style_base_policy_hash?: string | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          symbol: string
          take_profit?: number | null
          timeframe_relationship?: string | null
          tp_hit?: boolean | null
          tp_hit_time_minutes?: number | null
          trading_style: string
          user_id: string
          zone_high: number
          zone_low: number
          zone_type: string
        }
        Update: {
          activation_eligible?: boolean
          bot_id?: string
          candidate_id?: string
          candidate_lifecycle?: Json | null
          candidate_lifecycle_state?: string | null
          candidate_lineage?: Json | null
          candidate_model?: Json | null
          candidate_model_rank?: number | null
          candidate_model_version?: string | null
          candidate_model_winner?: boolean
          created_at?: string
          cross_tf_disagreed?: boolean
          cross_tf_evaluation?: Json | null
          cross_tf_policy?: Json | null
          cross_tf_policy_version?: string | null
          cross_tf_reason_codes?: string[]
          cross_tf_shadow_decision?: string | null
          direction?: string
          entry_price?: number
          evidence_source?: string
          id?: string
          legacy_comparable_score?: number
          legacy_execution_decision?: string | null
          legacy_rank?: number
          legacy_winner?: boolean
          legacy_zone_score?: number
          local_confluence?: Json
          mae_pips?: number | null
          mfe_pips?: number | null
          observed_at?: string
          outcome_checked_at?: string | null
          outcome_status?: string
          parent_candidate_id?: string | null
          price_reached_entry?: boolean | null
          rank_delta?: number
          ranking_disagreed?: boolean
          replay_contract_version?: string | null
          replay_run_id?: string | null
          scan_cycle_id?: string
          shadow_local_score?: number
          shadow_rank?: number
          shadow_ranking?: Json
          shadow_winner?: boolean
          sl_hit?: boolean | null
          stop_loss?: number | null
          style_base_policy_hash?: string | null
          style_policy_hash?: string | null
          style_policy_version?: string | null
          symbol?: string
          take_profit?: number | null
          timeframe_relationship?: string | null
          tp_hit?: boolean | null
          tp_hit_time_minutes?: number | null
          trading_style?: string
          user_id?: string
          zone_high?: number
          zone_low?: number
          zone_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "zone_candidate_shadow_observations_replay_run_id_fkey"
            columns: ["replay_run_id"]
            isOneToOne: false
            referencedRelation: "backtest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      zone_confirmation_evidence_counters: {
        Row: {
          bot_id: string
          last_attempt: number
          pending_order_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          bot_id: string
          last_attempt?: number
          pending_order_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          bot_id?: string
          last_attempt?: number
          pending_order_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      zone_timeframe_evidence: {
        Row: {
          bot_id: string
          canonical_detector_version: string | null
          canonical_parity: boolean | null
          confirmation_attempt: number
          contract_version: string
          created_at: string
          direction: string
          engine_options: Json
          evaluated_at: string
          event_linked: boolean
          evidence_source: string
          final_reason: string | null
          golden_replay_linked: boolean
          has_disagreement: boolean
          id: string
          linked_setup_id: string | null
          linked_trade_id: string | null
          observed_at: string
          parent_evidence_id: string | null
          payload_truncated: boolean
          pending_order_id: string
          replay_provenance: string | null
          replay_run_id: string | null
          scan_cycle_id: string
          selected_timeframe: string | null
          slots: Json
          style_base_policy_hash: string | null
          style_policy_hash: string | null
          style_policy_snapshot: Json | null
          style_policy_version: string | null
          symbol: string
          trading_style: string | null
          truncation_detail: Json | null
          user_id: string
        }
        Insert: {
          bot_id: string
          canonical_detector_version?: string | null
          canonical_parity?: boolean | null
          confirmation_attempt?: number
          contract_version?: string
          created_at?: string
          direction: string
          engine_options?: Json
          evaluated_at?: string
          event_linked?: boolean
          evidence_source?: string
          final_reason?: string | null
          golden_replay_linked?: boolean
          has_disagreement?: boolean
          id?: string
          linked_setup_id?: string | null
          linked_trade_id?: string | null
          observed_at?: string
          parent_evidence_id?: string | null
          payload_truncated?: boolean
          pending_order_id?: string
          replay_provenance?: string | null
          replay_run_id?: string | null
          scan_cycle_id: string
          selected_timeframe?: string | null
          slots?: Json
          style_base_policy_hash?: string | null
          style_policy_hash?: string | null
          style_policy_snapshot?: Json | null
          style_policy_version?: string | null
          symbol: string
          trading_style?: string | null
          truncation_detail?: Json | null
          user_id: string
        }
        Update: {
          bot_id?: string
          canonical_detector_version?: string | null
          canonical_parity?: boolean | null
          confirmation_attempt?: number
          contract_version?: string
          created_at?: string
          direction?: string
          engine_options?: Json
          evaluated_at?: string
          event_linked?: boolean
          evidence_source?: string
          final_reason?: string | null
          golden_replay_linked?: boolean
          has_disagreement?: boolean
          id?: string
          linked_setup_id?: string | null
          linked_trade_id?: string | null
          observed_at?: string
          parent_evidence_id?: string | null
          payload_truncated?: boolean
          pending_order_id?: string
          replay_provenance?: string | null
          replay_run_id?: string | null
          scan_cycle_id?: string
          selected_timeframe?: string | null
          slots?: Json
          style_base_policy_hash?: string | null
          style_policy_hash?: string | null
          style_policy_snapshot?: Json | null
          style_policy_version?: string | null
          symbol?: string
          trading_style?: string | null
          truncation_detail?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      zone_timeframe_evidence_summary: {
        Row: {
          bot_id: string
          canonical_detector_version: string | null
          canonical_parity: boolean | null
          confirmation_attempt: number | null
          contract_version: string | null
          created_at: string
          direction: string
          event_linked: boolean
          evidence_hash: string
          evidence_id: string
          evidence_source: string | null
          final_reason: string | null
          golden_replay_linked: boolean
          has_disagreement: boolean
          id: string
          observed_at: string
          parent_evidence_id: string | null
          pending_order_id: string | null
          rejection_code_counts: Json
          scan_cycle_id: string
          selected_timeframe: string | null
          style_base_policy_hash: string | null
          style_policy_hash: string | null
          style_policy_snapshot: Json | null
          style_policy_version: string | null
          symbol: string
          trading_style: string | null
          user_id: string
          winner_candidate_id: string | null
        }
        Insert: {
          bot_id: string
          canonical_detector_version?: string | null
          canonical_parity?: boolean | null
          confirmation_attempt?: number | null
          contract_version?: string | null
          created_at?: string
          direction: string
          event_linked?: boolean
          evidence_hash: string
          evidence_id: string
          evidence_source?: string | null
          final_reason?: string | null
          golden_replay_linked?: boolean
          has_disagreement?: boolean
          id?: string
          observed_at: string
          parent_evidence_id?: string | null
          pending_order_id?: string | null
          rejection_code_counts?: Json
          scan_cycle_id: string
          selected_timeframe?: string | null
          style_base_policy_hash?: string | null
          style_policy_hash?: string | null
          style_policy_snapshot?: Json | null
          style_policy_version?: string | null
          symbol: string
          trading_style?: string | null
          user_id: string
          winner_candidate_id?: string | null
        }
        Update: {
          bot_id?: string
          canonical_detector_version?: string | null
          canonical_parity?: boolean | null
          confirmation_attempt?: number | null
          contract_version?: string | null
          created_at?: string
          direction?: string
          event_linked?: boolean
          evidence_hash?: string
          evidence_id?: string
          evidence_source?: string | null
          final_reason?: string | null
          golden_replay_linked?: boolean
          has_disagreement?: boolean
          id?: string
          observed_at?: string
          parent_evidence_id?: string | null
          pending_order_id?: string | null
          rejection_code_counts?: Json
          scan_cycle_id?: string
          selected_timeframe?: string | null
          style_base_policy_hash?: string | null
          style_policy_hash?: string | null
          style_policy_snapshot?: Json | null
          style_policy_version?: string | null
          symbol?: string
          trading_style?: string | null
          user_id?: string
          winner_candidate_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      cross_timeframe_authority_runtime_status: {
        Row: {
          activation_updated_at: string | null
          allow_standalone_lower_timeframe: boolean | null
          authority_stage: string | null
          available: boolean | null
          bot_id: string | null
          certified_maximum: string | null
          effective_mode: string | null
          evidence_hash: string | null
          maximum_candidates_per_timeframe: number | null
          maximum_zone_separation_atr: number | null
          minimum_parent_child_overlap_percent: number | null
          requested_mode: string | null
          require_nested_impulse: boolean | null
          require_sweep_origin: boolean | null
          retest_quality: string | null
          revision: number | null
          runtime_enforced: boolean | null
          runtime_scope: string | null
          runtime_target: string | null
          user_id: string | null
        }
        Relationships: []
      }
      cross_timeframe_entry_authority_audit: {
        Row: {
          bot_id: string | null
          candidate_id: string | null
          cross_tf_effective_mode: string | null
          cross_tf_entry_allowed: boolean | null
          cross_tf_entry_authority: Json | null
          direction: string | null
          lifecycle_stage: string | null
          observed_at: string | null
          row_id: string | null
          symbol: string | null
          user_id: string | null
        }
        Relationships: []
      }
      ict_entry_zone_authority_validation_summary: {
        Row: {
          activation_eligible: boolean | null
          authority_avg_mae_pips: number | null
          authority_avg_mfe_pips: number | null
          authority_losers: number | null
          authority_winners: number | null
          bot_id: string | null
          disagreement_scans: number | null
          enforcement: string | null
          evidence_source: string | null
          false_positives: number | null
          losers_avoided: number | null
          minimum_sample_ready: boolean | null
          missed_opportunities: number | null
          observed_scans: number | null
          replay_runs: number | null
          resolved_authority_setups: number | null
          symbol: string | null
          trading_style: string | null
          user_id: string | null
          winners_retained: number | null
        }
        Relationships: []
      }
      impulse_entry_lifecycle_replay_summary: {
        Row: {
          added_losses: number | null
          avg_mae: number | null
          avg_mfe: number | null
          bot_id: string | null
          deeper_entries: number | null
          entries: number | null
          evidence_source: string | null
          losers: number | null
          minimum_sample_ready: boolean | null
          replay_count: number | null
          rescued_winners: number | null
          user_id: string | null
          winners: number | null
          winners_retained: number | null
        }
        Relationships: []
      }
      zone_candidate_shadow_validation_summary: {
        Row: {
          activation_eligible: boolean | null
          bot_id: string | null
          cross_tf_avg_mae_pips: number | null
          cross_tf_avg_mfe_pips: number | null
          cross_tf_disagreement_scans: number | null
          cross_tf_enforcement: string | null
          cross_tf_expectancy_delta_r: number | null
          cross_tf_expectancy_r: number | null
          cross_tf_minimum_sample_ready: boolean | null
          cross_tf_resolved_legacy_trades: number | null
          disagreement_scans: number | null
          enforcement: string | null
          evidence_source: string | null
          false_positives: number | null
          legacy_disagreement_samples: number | null
          legacy_disagreement_win_rate: number | null
          legacy_expectancy_r: number | null
          losers_avoided: number | null
          minimum_sample_ready: boolean | null
          missed_opportunities: number | null
          observed_scans: number | null
          replay_runs: number | null
          resolved_candidates: number | null
          shadow_disagreement_samples: number | null
          shadow_disagreement_win_rate: number | null
          shadow_winner_avg_mae_pips: number | null
          shadow_winner_avg_mfe_pips: number | null
          symbol: string | null
          trading_style: string | null
          user_id: string | null
          winners_retained: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      activate_direction_verdict: {
        Args: {
          p_agreement: number
          p_block_reason: string
          p_bot_id: string
          p_confidence: number
          p_evaluated_at: string
          p_expires_at: string
          p_game_plan_id: string
          p_game_plan_version: string
          p_scan_cycle_id: string
          p_score_adjustment: number
          p_should_block: boolean
          p_source_candle_timestamp: string
          p_symbol: string
          p_user_id: string
          p_verdict: string
          p_verdict_json: Json
          p_verdict_version: string
        }
        Returns: Json
      }
      activate_game_plan_version: {
        Args: {
          p_bot_id: string
          p_config_snapshot: Json
          p_market_data_snapshot: Json
          p_plan_version: string
          p_session_plan: Json
          p_source: string
          p_user_id: string
        }
        Returns: Json
      }
      advance_impulse_entry_lifecycle: {
        Args: {
          p_event_payload: Json
          p_event_type: string
          p_expected_revision: number
          p_lifecycle_id: string
          p_next_lifecycle: Json
          p_reason: string
        }
        Returns: {
          active_candidate_id: string | null
          bot_id: string
          created_at: string
          direction: string
          id: string
          impulse_id: string
          impulse_timeframe: string
          lifecycle: Json
          mode: string
          revision: number
          setup_id: string
          status: string
          symbol: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "impulse_entry_lifecycles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      allocate_zone_confirmation_evidence_attempt: {
        Args: {
          p_bot_id: string
          p_pending_order_id: string
          p_user_id: string
        }
        Returns: number
      }
      claim_broker_execution: {
        Args: {
          p_action: string
          p_bot_id: string
          p_broker_connection_id: string
          p_position_id: string
          p_request_payload: Json
          p_route: string
          p_user_id: string
        }
        Returns: Json
      }
      claim_scanner_runtime_lock: {
        Args: {
          p_bot_id: string
          p_lease_seconds?: number
          p_lease_token: string
          p_lock_scope: string
          p_run_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      claim_telegram_notification: {
        Args: { p_claim_key: string; p_expires_at: string }
        Returns: boolean
      }
      complete_broker_execution: {
        Args: {
          p_broker_order_id: string
          p_claim_token: string
          p_last_error: string
          p_ledger_id: string
          p_response_payload: Json
          p_status: string
          p_user_id: string
        }
        Returns: Json
      }
      evaluate_scanner_operational_health: { Args: never; Returns: Json }
      finalize_live_broker_position: {
        Args: { p_bot_id: string; p_position_id: string; p_user_id: string }
        Returns: Json
      }
      finalize_market_entry: {
        Args: {
          p_allow_same_direction: boolean
          p_authorization: Json
          p_bot_id: string
          p_close_on_reverse: boolean
          p_max_open_positions: number
          p_max_per_symbol: number
          p_position: Json
          p_source_candidate_key: string
          p_user_id: string
        }
        Returns: Json
      }
      finalize_pending_order_fill: {
        Args: {
          p_allow_same_direction: boolean
          p_authorization: Json
          p_bot_id: string
          p_current_price: number
          p_fill_price: number
          p_fill_reason: string
          p_max_open_positions: number
          p_max_per_symbol: number
          p_pending_id: string
          p_position_order_id: string
          p_signal_reason: Json
          p_user_id: string
        }
        Returns: Json
      }
      heartbeat_scanner_runtime_lock: {
        Args: {
          p_bot_id: string
          p_lease_seconds?: number
          p_lease_token: string
          p_lock_scope: string
          p_user_id: string
        }
        Returns: boolean
      }
      publish_strategy_evidence_certificate: {
        Args: {
          p_activation_scope: Json
          p_bot_id: string
          p_certificate: Json
          p_feature_key: string
          p_user_id: string
          p_variant_key: string
        }
        Returns: Json
      }
      release_scanner_runtime_lock: {
        Args: {
          p_bot_id: string
          p_lease_token: string
          p_lock_scope: string
          p_user_id: string
        }
        Returns: boolean
      }
      reserve_api_credit:
        | {
            Args: {
              p_limit: number
              p_provider: string
              p_window_seconds?: number
            }
            Returns: boolean
          }
        | {
            Args: {
              p_caller?: string
              p_limit: number
              p_provider: string
              p_window_seconds?: number
            }
            Returns: boolean
          }
      resolve_scanner_operational_alert: {
        Args: {
          p_alert_type: string
          p_bot_id: string
          p_dedupe_key?: string
          p_user_id: string
        }
        Returns: number
      }
      retarget_pending_to_impulse_candidate: {
        Args: { p_bot_id: string; p_pending_id: string; p_user_id: string }
        Returns: Json
      }
      review_impulse_lifecycle_certificate: {
        Args: { p_evidence_hash: string }
        Returns: Json
      }
      set_strategy_runtime_enforcement: {
        Args: {
          p_activation_scope: Json
          p_actor_id?: string
          p_bot_id: string
          p_enabled: boolean
          p_expected_revision?: number
          p_feature_key: string
          p_reason: string
          p_user_id: string
          p_variant_key: string
        }
        Returns: Json
      }
      strategy_activation_json_hash: {
        Args: { p_value: Json }
        Returns: string
      }
      transition_staged_setup: {
        Args: {
          p_evidence?: Json
          p_pending_order_id?: string
          p_position_id?: string
          p_reason: string
          p_setup_id: string
          p_to_status: string
          p_user_id: string
        }
        Returns: Json
      }
      transition_strategy_activation: {
        Args: {
          p_activation_scope: Json
          p_actor_id?: string
          p_bot_id: string
          p_evidence_snapshot: Json
          p_evidence_window_end?: string
          p_evidence_window_start?: string
          p_expected_revision?: number
          p_feature_key: string
          p_reason: string
          p_to_authority_stage: string
          p_to_runtime_scope: string
          p_user_id: string
          p_variant_key: string
        }
        Returns: Json
      }
      upsert_scanner_operational_alert: {
        Args: {
          p_alert_type: string
          p_bot_id: string
          p_dedupe_key: string
          p_evidence?: Json
          p_message: string
          p_run_id?: string
          p_severity: string
          p_title: string
          p_user_id: string
        }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
