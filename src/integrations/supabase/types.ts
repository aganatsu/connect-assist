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
      backtest_runs: {
        Row: {
          completed_at: string | null
          config: Json
          created_at: string
          error_message: string | null
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
          close_reason: string | null
          created_at: string
          current_price: number | null
          current_price_old: string | null
          direction: string
          entry_price: number | null
          entry_price_old: string | null
          id: string
          mirrored_connection_ids: string[]
          open_time: string
          order_id: string
          order_type: string | null
          partial_tp_fired: boolean
          position_id: string
          position_status: string
          signal_reason: string | null
          signal_score: string
          size: number | null
          size_old: string | null
          stop_loss: number | null
          stop_loss_old: string | null
          symbol: string
          take_profit: number | null
          take_profit_old: string | null
          trigger_price: string | null
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          close_reason?: string | null
          created_at?: string
          current_price?: number | null
          current_price_old?: string | null
          direction: string
          entry_price?: number | null
          entry_price_old?: string | null
          id?: string
          mirrored_connection_ids?: string[]
          open_time: string
          order_id: string
          order_type?: string | null
          partial_tp_fired?: boolean
          position_id: string
          position_status?: string
          signal_reason?: string | null
          signal_score?: string
          size?: number | null
          size_old?: string | null
          stop_loss?: number | null
          stop_loss_old?: string | null
          symbol: string
          take_profit?: number | null
          take_profit_old?: string | null
          trigger_price?: string | null
          user_id: string
        }
        Update: {
          bot_id?: string | null
          close_reason?: string | null
          created_at?: string
          current_price?: number | null
          current_price_old?: string | null
          direction?: string
          entry_price?: number | null
          entry_price_old?: string | null
          id?: string
          mirrored_connection_ids?: string[]
          open_time?: string
          order_id?: string
          order_type?: string | null
          partial_tp_fired?: boolean
          position_id?: string
          position_status?: string
          signal_reason?: string | null
          signal_score?: string
          size?: number | null
          size_old?: string | null
          stop_loss?: number | null
          stop_loss_old?: string | null
          symbol?: string
          take_profit?: number | null
          take_profit_old?: string | null
          trigger_price?: string | null
          user_id?: string
        }
        Relationships: []
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
          created_at: string
          current_price: number
          direction: string
          entry_price: number
          entry_zone_high: number | null
          entry_zone_low: number | null
          entry_zone_type: string | null
          exit_flags: Json | null
          expires_at: string
          expiry_minutes: number
          fill_reason: string | null
          filled_at: string | null
          from_watchlist: boolean
          id: string
          order_id: string
          order_type: string
          placed_at: string
          resolved_at: string | null
          setup_confidence: number | null
          setup_type: string | null
          signal_reason: Json | null
          signal_score: number | null
          size: number
          staged_cycles: number | null
          staged_initial_score: number | null
          status: string
          stop_loss: number
          symbol: string
          take_profit: number
          updated_at: string
          user_id: string
        }
        Insert: {
          bot_id?: string
          cancel_reason?: string | null
          created_at?: string
          current_price: number
          direction: string
          entry_price: number
          entry_zone_high?: number | null
          entry_zone_low?: number | null
          entry_zone_type?: string | null
          exit_flags?: Json | null
          expires_at: string
          expiry_minutes?: number
          fill_reason?: string | null
          filled_at?: string | null
          from_watchlist?: boolean
          id?: string
          order_id: string
          order_type?: string
          placed_at?: string
          resolved_at?: string | null
          setup_confidence?: number | null
          setup_type?: string | null
          signal_reason?: Json | null
          signal_score?: number | null
          size: number
          staged_cycles?: number | null
          staged_initial_score?: number | null
          status?: string
          stop_loss: number
          symbol: string
          take_profit: number
          updated_at?: string
          user_id: string
        }
        Update: {
          bot_id?: string
          cancel_reason?: string | null
          created_at?: string
          current_price?: number
          direction?: string
          entry_price?: number
          entry_zone_high?: number | null
          entry_zone_low?: number | null
          entry_zone_type?: string | null
          exit_flags?: Json | null
          expires_at?: string
          expiry_minutes?: number
          fill_reason?: string | null
          filled_at?: string | null
          from_watchlist?: boolean
          id?: string
          order_id?: string
          order_type?: string
          placed_at?: string
          resolved_at?: string | null
          setup_confidence?: number | null
          setup_type?: string | null
          signal_reason?: Json | null
          signal_score?: number | null
          size?: number
          staged_cycles?: number | null
          staged_initial_score?: number | null
          status?: string
          stop_loss?: number
          symbol?: string
          take_profit?: number
          updated_at?: string
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
      staged_setups: {
        Row: {
          analysis_snapshot: Json | null
          bot_id: string
          created_at: string
          current_factors: Json
          current_score: number
          direction: string
          entry_price: number | null
          id: string
          initial_factors: Json
          initial_score: number
          invalidation_reason: string | null
          last_eval_at: string
          min_cycles: number
          missing_factors: Json
          promotion_reason: string | null
          resolved_at: string | null
          scan_cycles: number
          setup_type: string | null
          sl_level: number | null
          staged_at: string
          status: string
          symbol: string
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
          bot_id?: string
          created_at?: string
          current_factors?: Json
          current_score: number
          direction: string
          entry_price?: number | null
          id?: string
          initial_factors?: Json
          initial_score: number
          invalidation_reason?: string | null
          last_eval_at?: string
          min_cycles?: number
          missing_factors?: Json
          promotion_reason?: string | null
          resolved_at?: string | null
          scan_cycles?: number
          setup_type?: string | null
          sl_level?: number | null
          staged_at?: string
          status?: string
          symbol: string
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
          bot_id?: string
          created_at?: string
          current_factors?: Json
          current_score?: number
          direction?: string
          entry_price?: number | null
          id?: string
          initial_factors?: Json
          initial_score?: number
          invalidation_reason?: string | null
          last_eval_at?: string
          min_cycles?: number
          missing_factors?: Json
          promotion_reason?: string | null
          resolved_at?: string | null
          scan_cycles?: number
          setup_type?: string | null
          sl_level?: number | null
          staged_at?: string
          status?: string
          symbol?: string
          tier1_count?: number
          tier2_count?: number
          tier3_count?: number
          tp_level?: number | null
          ttl_minutes?: number
          updated_at?: string
          user_id?: string
          watch_threshold?: number
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
          entry_price_old: string
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
          entry_price_old: string
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
          entry_price_old?: string
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
      [_ in never]: never
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
