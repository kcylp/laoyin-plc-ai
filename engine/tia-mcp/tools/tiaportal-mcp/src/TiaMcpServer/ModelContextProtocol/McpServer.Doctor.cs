using ModelContextProtocol;
using ModelContextProtocol.Server;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using TiaMcpServer.Siemens;

namespace TiaMcpServer.ModelContextProtocol
{
    // Doctor: one-call environment diagnosis for non-experts / fresh machines.
    // Ported from the pre-split repo where it shipped alongside the lite profile;
    // SKILL.md documents it, so the tool must exist in every released build.
    public static partial class McpServer
    {
        [McpServerTool(Name = "Doctor"), Description("[L0][Diagnostics] One-call read-only environment doctor for non-experts. Checks TIA install, Openness group membership, and connection/project state, and returns a plain-language diagnosis with the exact manual fix per problem. Does not add users or prompt UAC. Call this first when setup is failing or you are unsure the environment is ready.")]
        public static async Task<ResponseDoctor> Doctor(
            [Description("Compatibility flag retained; Doctor is always read-only and never adds users or prompts UAC.")] bool fix = true)
        {
            try
            {
                _ = fix;
                await Task.CompletedTask;
                var checks = new List<DoctorCheck>();

                // 1) TIA installation
                int? inUse = Engineering.TiaMajorVersion == 0 ? (int?)null : Engineering.TiaMajorVersion;
                int? detected = Engineering.DetectTiaMajorVersion();
                bool tiaOk = inUse != null || detected != null;
                checks.Add(new DoctorCheck
                {
                    Name = "TIA Portal installation",
                    Ok = tiaOk,
                    Detail = tiaOk ? $"detected V{(inUse ?? detected)}" : "no TIA Portal detected",
                    Fix = tiaOk ? null : "Install TIA Portal V18+ with the Openness option, then set the user environment variable TiaPortalLocation to the install path (e.g. C:\\Program Files\\Siemens\\Automation\\Portal V21)."
                });

                // 2) Openness group membership (read-only; never auto-fixes)
                bool groupOk;
                try { groupOk = Siemens.Openness.IsUserInGroupNoFix(); }
                catch { groupOk = false; }
                checks.Add(new DoctorCheck
                {
                    Name = "Openness user group",
                    Ok = groupOk,
                    Detail = groupOk ? "current user is in 'Siemens TIA Openness' group" : "current user NOT in 'Siemens TIA Openness' group",
                    Fix = groupOk ? null : OpennessManualFix()
                });

                // 3) Connection + project state
                bool connected = false; string? projectName = null;
                try { var st = Portal.GetState(); connected = st?.IsConnected ?? false; projectName = st?.Project; }
                catch { }
                bool hasProject = !string.IsNullOrWhiteSpace(projectName) && projectName != "-";
                checks.Add(new DoctorCheck
                {
                    Name = "TIA connection / project",
                    Ok = connected,
                    Detail = connected ? (hasProject ? $"connected, project '{projectName}' open" : "connected, no project bound") : "not connected",
                    Fix = connected ? (hasProject ? null : "Call AttachToOpenProject (if a project is open in TIA UI) or OpenProject/CreateProject.") : "Call Connect (first call may pop an Openness authorization dialog in TIA — click Yes)."
                });

                string next;
                if (!tiaOk) next = "(install TIA Portal)";
                else if (!groupOk) next = "(manual Openness group fix)";
                else if (!connected) next = "Connect";
                else if (!hasProject) next = "AttachToOpenProject";
                else next = "GetProjectTree";

                bool ready = tiaOk && groupOk;
                var failed = checks.Where(c => !c.Ok).Select(c => c.Name).ToList();
                string summary = ready && connected && hasProject
                    ? "Environment healthy — project open, ready to work."
                    : ready
                        ? "Environment OK — connect/open a project next."
                        : $"Not ready. Fix: {string.Join("; ", failed)}.";

                return new ResponseDoctor
                {
                    Ready = ready,
                    Checks = checks,
                    RecommendedNextTool = next,
                    Summary = summary,
                    Message = summary,
                    Meta = new JsonObject { ["timestamp"] = DateTime.Now, ["success"] = true }
                };
            }
            catch (Exception ex) when (ex is not McpException)
            {
                throw new McpException($"Doctor unexpected error: {ex.Message}", ex, McpErrorCode.InternalError);
            }
        }
    }
}
