#!/bin/sh
# Open the cloud provider's log viewer for the selected sofka row.
# Usage: cloud-logs.sh CONTEXT CLUSTER RESOURCE NAMESPACE NAME
# To add a provider, write a <provider>_url function and match its kubeconfig cluster names in the dispatch at the end.
set -eu

die() {
  echo "cloud-logs: $*" >&2
  exit 1
}

[ $# -eq 5 ] || die "usage: cloud-logs.sh CONTEXT CLUSTER RESOURCE NAMESPACE NAME"
context=$1 cluster=$2 resource=$3 namespace=$4 name=$5
[ -n "$context" ] || die "no kubeconfig context"
[ -n "$cluster" ] || die "context \"$context\" names no cluster"

nl='
'
# Percent-encode every byte outside the RFC 3986 unreserved set. od and awk avoid a jq or python dependency.
urlencode() {
  printf %s "$1" | od -An -v -tu1 | awk '{
    for (i = 1; i <= NF; i++) {
      c = $i
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 45 || c == 46 || c == 95 || c == 126)
        printf "%c", c
      else
        printf "%%%02X", c
    }
  }'
}

open_url() {
  case $(uname -s) in
    Darwin) open "$1" ;;
    *)
      command -v xdg-open >/dev/null 2>&1 || die "xdg-open not found"
      xdg-open "$1" >/dev/null 2>&1
      ;;
  esac
}

# Print the pod selector of the selected row, one "KEY OPERATOR [VALUE...]" requirement per line.
# The selector matches every pod the workload owns, including pods that no longer exist, and never a pod of another workload.
read_selector() {
  # shellcheck disable=SC2016 # $k and $v are go-template variables
  case $resource in
    services) tpl='{{range $k, $v := .spec.selector}}{{$k}} In {{$v}}{{"\n"}}{{end}}' ;;
    *) tpl='{{range $k, $v := .spec.selector.matchLabels}}{{$k}} In {{$v}}{{"\n"}}{{end}}{{range .spec.selector.matchExpressions}}{{.key}} {{.operator}}{{range .values}} {{.}}{{end}}{{"\n"}}{{end}}' ;;
  esac
  kubectl --context "$context" --request-timeout=15s -n "$namespace" get "$resource" "$name" -o go-template="$tpl" ||
    die "cannot read the pod selector of $resource/$name"
}

selector=
case $resource in
  deployments | statefulsets | daemonsets | replicasets | jobs | services)
    selector=$(read_selector)
    [ -n "$selector" ] || die "$resource/$name has no pod selector"
    ;;
esac

# GKE writes pod label "a.b/c" as log label "k8s-pod/a_b/c".
gcp_label_term() {
  field="labels.\"k8s-pod/$(printf %s "$1" | tr . _)\""
  op=$2
  shift 2
  any=
  for v in "$@"; do any="$any${any:+ OR }$field=\"$v\""; done
  case $op in
    In) if [ $# -eq 1 ]; then echo "$any"; else echo "($any)"; fi ;;
    NotIn) echo "NOT ($any)" ;;
    Exists) echo "$field:*" ;;
    DoesNotExist) echo "NOT $field:*" ;;
    *) die "unknown selector operator \"$op\"" ;;
  esac
}

gcp_url() {
  # GKE kubeconfig names are gke_<project>_<location>_<cluster>, and no part can contain "_".
  rest=${cluster#gke_}
  project=${rest%%_*}
  rest=${rest#*_}
  location=${rest%%_*}
  cluster_name=${rest#*_}
  case $cluster_name in *_*) die "cannot parse GKE cluster name \"$cluster\"" ;; esac

  q=
  add() { q="$q${q:+$nl}$1"; }
  if [ "$resource" = nodes ]; then
    add 'resource.type="k8s_node"'
  else
    add 'resource.type="k8s_container"'
  fi
  add "resource.labels.project_id=\"$project\""
  add "resource.labels.location=\"$location\""
  add "resource.labels.cluster_name=\"$cluster_name\""
  case $resource in
    nodes) add "resource.labels.node_name=\"$name\"" ;;
    namespaces) add "resource.labels.namespace_name=\"$name\"" ;;
    *)
      [ -z "$namespace" ] || add "resource.labels.namespace_name=\"$namespace\""
      case $resource in
        pods) add "resource.labels.pod_name=\"$name\"" ;;
        # A CronJob has no selector, but GKE tags each of its pods with the CronJob name.
        cronjobs)
          add 'labels."logging.gke.io/top_level_controller_type"="CronJob"'
          add "labels.\"logging.gke.io/top_level_controller_name\"=\"$name\""
          ;;
        *)
          while read -r requirement; do
            # shellcheck disable=SC2086 # split "KEY OPERATOR VALUE..." into arguments
            term=$(gcp_label_term $requirement)
            add "$term"
          done <<EOF
$selector
EOF
          ;;
      esac
      ;;
  esac

  echo "https://console.cloud.google.com/logs/query;query=$(urlencode "$q");duration=PT1H?project=$(urlencode "$project")"
}

case $cluster in
  gke_?*_?*_?*) url=$(gcp_url) ;;
  *) die "no log provider matches cluster \"$cluster\" (supported: GKE)" ;;
esac
open_url "$url"
