// Supabase 연결 설정
// - supabaseUrl, supabaseAnonKey 는 클라이언트에 노출되어도 안전한 값입니다.
//   보안은 Supabase 대시보드의 Row Level Security(RLS) 정책으로 관리하세요.
// - service_role key / DB 비밀번호는 절대 여기에 넣지 마세요.
//
// Supabase 대시보드 → Project Settings → API 에서 값을 확인하세요.
export const APP_CONFIG = {
    version: "v0.8b",
    supabaseEnabled: true,         // 연결을 켜려면 true 로 바꾸세요
    supabaseUrl: "https://yspqjrrojcbljxbdsajn.supabase.co",                // Project URL
    supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzcHFqcnJvamNibGp4YmRzYWpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NTUyMjcsImV4cCI6MjA5NDUzMTIyN30.ZHRFvvphcyXu1HnY8Qpo8VsL7cgcmV3kMikcAXFCISs"
}
