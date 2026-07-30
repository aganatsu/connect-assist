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
          candidate_id: string | null
          close_reason: string | null
          confirmation_config: Json
          confirmation_method: string | null
          created_at: string
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
          candidate_id?: string | null
          close_reason?: string | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
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
          candidate_id?: string | null
          close_reason?: string | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
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
          confirmation_attempts: number | null
          confirmation_config: Json
          confirmation_method: string | null
          created_at: string
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
          last_confirmation_checked_at: string | null
          order_id: string
          order_type: string
          originating_zone: Json | null
          placed_at: string
          policy_frozen_at: string | null
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
          confirmation_attempts?: number | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
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
          last_confirmation_checked_at?: string | null
          order_id: string
          order_type?: string
          originating_zone?: Json | null
          placed_at?: string
          policy_frozen_at?: string | null
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
          confirmation_attempts?: number | null
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
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
          last_confirmation_checked_at?: string | null
          order_id?: string
          order_type?: string
          originating_zone?: Json | null
          placed_at?: string
          policy_frozen_at?: string | null
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
          direction: string
          entry_price: number
          failed_gates: string[] | null
          fotsi_base_tsi: number | null
          fotsi_quote_tsi: number | null
          gp_bias: string | null
          gp_bias_confidence: number | null
          id: string
          mae_pips: number | null
          mfe_pips: number | null
          normalized_gates: string[]
          opportunity_key: string | null
          outcome_checked_at: string | null
          outcome_status: string
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
          stop_loss: number | null
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
          direction: string
          entry_price: number
          failed_gates?: string[] | null
          fotsi_base_tsi?: number | null
          fotsi_quote_tsi?: number | null
          gp_bias?: string | null
          gp_bias_confidence?: number | null
          id?: string
          mae_pips?: number | null
          mfe_pips?: number | null
          normalized_gates?: string[]
          opportunity_key?: string | null
          outcome_checked_at?: string | null
          outcome_status?: string
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
          stop_loss?: number | null
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
          direction?: string
          entry_price?: number
          failed_gates?: string[] | null
          fotsi_base_tsi?: number | null
          fotsi_quote_tsi?: number | null
          gp_bias?: string | null
          gp_bias_confidence?: number | null
          id?: string
          mae_pips?: number | null
          mfe_pips?: number | null
          normalized_gates?: string[]
          opportunity_key?: string | null
          outcome_checked_at?: string | null
          outcome_status?: string
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
          stop_loss?: number | null
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
          reason: string | null
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
          reason?: string | null
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
          reason?: string | null
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
          confirmation_config: Json
          confirmation_method: string | null
          created_at: string
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
          initial_factors: Json
          initial_score: number
          invalidation_reason: string | null
          last_eval_at: string
          lifecycle_reason: string | null
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
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
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
          initial_factors?: Json
          initial_score: number
          invalidation_reason?: string | null
          last_eval_at?: string
          lifecycle_reason?: string | null
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
          confirmation_config?: Json
          confirmation_method?: string | null
          created_at?: string
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
          initial_factors?: Json
          initial_score?: number
          invalidation_reason?: string | null
          last_eval_at?: string
          lifecycle_reason?: string | null
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
    }
    Views: {
      [_ in never]: never
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
      resolve_scanner_operational_alert: {
        Args: {
          p_alert_type: string
          p_bot_id: string
          p_dedupe_key?: string
          p_user_id: string
        }
        Returns: number
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
