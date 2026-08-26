using Siemens.Engineering;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace TiaMcpServer.ModelContextProtocol
{
    public static class McpErrorDetail
    {
        public static string Format(Exception? ex)
        {
            var parts = Flatten(ex).ToList();
            return parts.Count == 0 ? string.Empty : string.Join(" | ", parts);
        }

        public static IEnumerable<string> Flatten(Exception? ex)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var current = ex; current != null; current = current.InnerException)
            {
                foreach (var text in FlattenOne(current))
                {
                    var normalized = Normalize(text);
                    if (normalized.Length > 0 && seen.Add(normalized))
                    {
                        yield return normalized;
                    }
                }
            }
        }

        private static IEnumerable<string?> FlattenOne(Exception ex)
        {
            yield return ex.Message;

            if (ex is EngineeringException engineeringEx)
            {
                foreach (var text in FlattenMessageData(engineeringEx.MessageData))
                {
                    yield return text;
                }

                if (engineeringEx.DetailMessageData != null)
                {
                    foreach (var detail in engineeringEx.DetailMessageData)
                    {
                        foreach (var text in FlattenMessageData(detail))
                        {
                            yield return text;
                        }
                    }
                }
            }
        }

        private static IEnumerable<string?> FlattenMessageData(ExceptionMessageData data)
        {
            yield return data.Text;
            yield return data.DetailText;
        }

        private static string Normalize(string? text)
        {
            if (string.IsNullOrWhiteSpace(text)) return string.Empty;
            var value = text!;
            var sb = new StringBuilder(value.Length);
            var lastWasWhiteSpace = false;
            foreach (var c in value.Trim())
            {
                if (char.IsWhiteSpace(c))
                {
                    if (!lastWasWhiteSpace)
                    {
                        sb.Append(' ');
                        lastWasWhiteSpace = true;
                    }
                }
                else
                {
                    sb.Append(c);
                    lastWasWhiteSpace = false;
                }
            }
            return sb.ToString();
        }
    }
}
