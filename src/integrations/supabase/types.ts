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
      broker_connections: {
        Row: {
          account_id: string
          api_key: string
          broker_type: string
          created_at: string
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
          created_at?: string
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
          created_at?: string
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
      paper_accounts: {
        Row: {
          balance: string
          bot_id: string | null
          created_at: string
          daily_pnl_base: string
          daily_pnl_date: string
          enable_orphan_close: boolean
          execution_mode: string
          id: string
          is_paused: boolean
          is_running: boolean
          kill_switch_active: boolean
          peak_balance: string
          rejected_count: number
          scan_count: number
          scan_lock_until: string | null
          signal_count: number
          started_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          balance?: string
          bot_id?: string | null
          created_at?: string
          daily_pnl_base?: string
          daily_pnl_date?: string
          enable_orphan_close?: boolean
          execution_mode?: string
          id?: string
          is_paused?: boolean
          is_running?: boolean
          kill_switch_active?: boolean
          peak_balance?: string
          rejected_count?: number
          scan_count?: number
          scan_lock_until?: string | null
          signal_count?: number
          started_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          balance?: string
          bot_id?: string | null
          created_at?: string
          daily_pnl_base?: string
          daily_pnl_date?: string
          enable_orphan_close?: boolean
          execution_mode?: string
          id?: string
          is_paused?: boolean
          is_running?: boolean
          kill_switch_active?: boolean
          peak_balance?: string
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
          current_price: string
          direction: string
          entry_price: string
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
          size: string
          stop_loss: string | null
          symbol: string
          take_profit: string | null
          trigger_price: string | null
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          close_reason?: string | null
          created_at?: string
          current_price: string
          direction: string
          entry_price: string
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
          size: string
          stop_loss?: string | null
          symbol: string
          take_profit?: string | null
          trigger_price?: string | null
          user_id: string
        }
        Update: {
          bot_id?: string | null
          close_reason?: string | null
          created_at?: string
          current_price?: string
          direction?: string
          entry_price?: string
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
          size?: string
          stop_loss?: string | null
          symbol?: string
          take_profit?: string | null
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
          entry_price: string
          exit_price: string
          id: string
          open_time: string
          order_id: string
          pnl: string
          pnl_pips: string
          position_id: string
          signal_reason: string | null
          signal_score: string
          size: string
          symbol: string
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          close_reason: string
          closed_at: string
          created_at?: string
          direction: string
          entry_price: string
          exit_price: string
          id?: string
          open_time: string
          order_id: string
          pnl: string
          pnl_pips: string
          position_id: string
          signal_reason?: string | null
          signal_score?: string
          size: string
          symbol: string
          user_id: string
        }
        Update: {
          bot_id?: string | null
          close_reason?: string
          closed_at?: string
          created_at?: string
          direction?: string
          entry_price?: string
          exit_price?: string
          id?: string
          open_time?: string
          order_id?: string
          pnl?: string
          pnl_pips?: string
          position_id?: string
          signal_reason?: string | null
          signal_score?: string
          size?: string
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      scan_logs: {
        Row: {
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
          entry_price: string
          entry_time: string
          exit_price: string | null
          exit_time: string | null
          followed_strategy: boolean | null
          id: string
          improvements: string | null
          notes: string | null
          pnl_amount: string | null
          pnl_pips: string | null
          position_size: string | null
          post_mortem_json: Json | null
          reasoning_json: Json | null
          risk_percent: string | null
          risk_reward: string | null
          screenshot_url: string | null
          setup_type: string | null
          status: string
          stop_loss: string | null
          symbol: string
          take_profit: string | null
          timeframe: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          confluence_score?: number | null
          created_at?: string
          deviations?: string | null
          direction: string
          entry_price: string
          entry_time: string
          exit_price?: string | null
          exit_time?: string | null
          followed_strategy?: boolean | null
          id?: string
          improvements?: string | null
          notes?: string | null
          pnl_amount?: string | null
          pnl_pips?: string | null
          position_size?: string | null
          post_mortem_json?: Json | null
          reasoning_json?: Json | null
          risk_percent?: string | null
          risk_reward?: string | null
          screenshot_url?: string | null
          setup_type?: string | null
          status?: string
          stop_loss?: string | null
          symbol: string
          take_profit?: string | null
          timeframe?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          confluence_score?: number | null
          created_at?: string
          deviations?: string | null
          direction?: string
          entry_price?: string
          entry_time?: string
          exit_price?: string | null
          exit_time?: string | null
          followed_strategy?: boolean | null
          id?: string
          improvements?: string | null
          notes?: string | null
          pnl_amount?: string | null
          pnl_pips?: string | null
          position_size?: string | null
          post_mortem_json?: Json | null
          reasoning_json?: Json | null
          risk_percent?: string | null
          risk_reward?: string | null
          screenshot_url?: string | null
          setup_type?: string | null
          status?: string
          stop_loss?: string | null
          symbol?: string
          take_profit?: string | null
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
