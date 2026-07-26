#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static _Atomic unsigned long count_socket_inet = 0;
static _Atomic unsigned long count_socket_inet6 = 0;
static _Atomic unsigned long count_connect = 0;
static _Atomic unsigned long count_bind = 0;
static _Atomic unsigned long count_listen = 0;
static _Atomic unsigned long count_accept = 0;
static _Atomic unsigned long count_send = 0;
static _Atomic unsigned long count_sendto = 0;
static _Atomic unsigned long count_sendmsg = 0;
static _Atomic unsigned long count_recv = 0;
static _Atomic unsigned long count_recvfrom = 0;
static _Atomic unsigned long count_recvmsg = 0;
static _Atomic unsigned long count_getaddrinfo = 0;
static _Atomic unsigned long count_getnameinfo = 0;
static _Atomic unsigned long count_gethostbyname = 0;
static _Atomic unsigned long count_gethostbyname2 = 0;

static bool is_ip_family(sa_family_t family) {
  return family == AF_INET || family == AF_INET6;
}

static bool is_ip_socket(int descriptor) {
  struct sockaddr_storage address;
  socklen_t length = sizeof(address);
  if (getsockname(descriptor, (struct sockaddr *)&address, &length) != 0) {
    return false;
  }
  return is_ip_family(address.ss_family);
}

static void increment(_Atomic unsigned long *counter) {
  atomic_fetch_add_explicit(counter, 1, memory_order_relaxed);
}

int usage_monitor_audit_socket(int domain, int type, int protocol) {
  if (domain == AF_INET) increment(&count_socket_inet);
  if (domain == AF_INET6) increment(&count_socket_inet6);
  return socket(domain, type, protocol);
}

int usage_monitor_audit_connect(
  int descriptor,
  const struct sockaddr *address,
  socklen_t length
) {
  if (address != NULL && is_ip_family(address->sa_family)) {
    increment(&count_connect);
  }
  return connect(descriptor, address, length);
}

int usage_monitor_audit_bind(
  int descriptor,
  const struct sockaddr *address,
  socklen_t length
) {
  if (address != NULL && is_ip_family(address->sa_family)) {
    increment(&count_bind);
  }
  return bind(descriptor, address, length);
}

int usage_monitor_audit_listen(int descriptor, int backlog) {
  if (is_ip_socket(descriptor)) increment(&count_listen);
  return listen(descriptor, backlog);
}

int usage_monitor_audit_accept(
  int descriptor,
  struct sockaddr *address,
  socklen_t *length
) {
  if (is_ip_socket(descriptor)) increment(&count_accept);
  return accept(descriptor, address, length);
}

ssize_t usage_monitor_audit_send(
  int descriptor,
  const void *buffer,
  size_t length,
  int flags
) {
  if (is_ip_socket(descriptor)) increment(&count_send);
  return send(descriptor, buffer, length, flags);
}

ssize_t usage_monitor_audit_sendto(
  int descriptor,
  const void *buffer,
  size_t length,
  int flags,
  const struct sockaddr *destination,
  socklen_t destination_length
) {
  if ((destination != NULL && is_ip_family(destination->sa_family))
      || is_ip_socket(descriptor)) {
    increment(&count_sendto);
  }
  return sendto(
    descriptor,
    buffer,
    length,
    flags,
    destination,
    destination_length
  );
}

ssize_t usage_monitor_audit_sendmsg(
  int descriptor,
  const struct msghdr *message,
  int flags
) {
  if ((message != NULL
        && message->msg_name != NULL
        && message->msg_namelen >= sizeof(sa_family_t)
        && is_ip_family(((const struct sockaddr *)message->msg_name)->sa_family))
      || is_ip_socket(descriptor)) {
    increment(&count_sendmsg);
  }
  return sendmsg(descriptor, message, flags);
}

ssize_t usage_monitor_audit_recv(
  int descriptor,
  void *buffer,
  size_t length,
  int flags
) {
  if (is_ip_socket(descriptor)) increment(&count_recv);
  return recv(descriptor, buffer, length, flags);
}

ssize_t usage_monitor_audit_recvfrom(
  int descriptor,
  void *buffer,
  size_t length,
  int flags,
  struct sockaddr *source,
  socklen_t *source_length
) {
  if (is_ip_socket(descriptor)) increment(&count_recvfrom);
  return recvfrom(
    descriptor,
    buffer,
    length,
    flags,
    source,
    source_length
  );
}

ssize_t usage_monitor_audit_recvmsg(
  int descriptor,
  struct msghdr *message,
  int flags
) {
  if (is_ip_socket(descriptor)) increment(&count_recvmsg);
  return recvmsg(descriptor, message, flags);
}

int usage_monitor_audit_getaddrinfo(
  const char *node,
  const char *service,
  const struct addrinfo *hints,
  struct addrinfo **results
) {
  increment(&count_getaddrinfo);
  return getaddrinfo(node, service, hints, results);
}

int usage_monitor_audit_getnameinfo(
  const struct sockaddr *address,
  socklen_t address_length,
  char *host,
  socklen_t host_length,
  char *service,
  socklen_t service_length,
  int flags
) {
  increment(&count_getnameinfo);
  return getnameinfo(
    address,
    address_length,
    host,
    host_length,
    service,
    service_length,
    flags
  );
}

struct hostent *usage_monitor_audit_gethostbyname(const char *name) {
  increment(&count_gethostbyname);
  return gethostbyname(name);
}

struct hostent *usage_monitor_audit_gethostbyname2(
  const char *name,
  int address_family
) {
  increment(&count_gethostbyname2);
  return gethostbyname2(name, address_family);
}

#define DYLD_INTERPOSE(replacement, replacee) \
  __attribute__((used)) static struct { \
    const void *replacement; \
    const void *replacee; \
  } interpose_##replacee __attribute__((section("__DATA,__interpose"))) = { \
    (const void *)(unsigned long)&replacement, \
    (const void *)(unsigned long)&replacee \
  }

DYLD_INTERPOSE(usage_monitor_audit_socket, socket);
DYLD_INTERPOSE(usage_monitor_audit_connect, connect);
DYLD_INTERPOSE(usage_monitor_audit_bind, bind);
DYLD_INTERPOSE(usage_monitor_audit_listen, listen);
DYLD_INTERPOSE(usage_monitor_audit_accept, accept);
DYLD_INTERPOSE(usage_monitor_audit_send, send);
DYLD_INTERPOSE(usage_monitor_audit_sendto, sendto);
DYLD_INTERPOSE(usage_monitor_audit_sendmsg, sendmsg);
DYLD_INTERPOSE(usage_monitor_audit_recv, recv);
DYLD_INTERPOSE(usage_monitor_audit_recvfrom, recvfrom);
DYLD_INTERPOSE(usage_monitor_audit_recvmsg, recvmsg);
DYLD_INTERPOSE(usage_monitor_audit_getaddrinfo, getaddrinfo);
DYLD_INTERPOSE(usage_monitor_audit_getnameinfo, getnameinfo);
DYLD_INTERPOSE(usage_monitor_audit_gethostbyname, gethostbyname);
DYLD_INTERPOSE(usage_monitor_audit_gethostbyname2, gethostbyname2);

static unsigned long load_count(_Atomic unsigned long *counter) {
  return atomic_load_explicit(counter, memory_order_relaxed);
}

static bool write_complete(int descriptor, const char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, bytes + offset, length - offset);
    if (written <= 0) return false;
    offset += (size_t)written;
  }
  return true;
}

__attribute__((destructor))
static void usage_monitor_write_native_network_audit(void) {
  const char *path = getenv("USAGE_MONITOR_NATIVE_NETWORK_AUDIT_FILE");
  if (path == NULL || path[0] != '/') return;

  unsigned long socket_inet = load_count(&count_socket_inet);
  unsigned long socket_inet6 = load_count(&count_socket_inet6);
  unsigned long connect_count = load_count(&count_connect);
  unsigned long bind_count = load_count(&count_bind);
  unsigned long listen_count = load_count(&count_listen);
  unsigned long accept_count = load_count(&count_accept);
  unsigned long send_count = load_count(&count_send);
  unsigned long sendto_count = load_count(&count_sendto);
  unsigned long sendmsg_count = load_count(&count_sendmsg);
  unsigned long recv_count = load_count(&count_recv);
  unsigned long recvfrom_count = load_count(&count_recvfrom);
  unsigned long recvmsg_count = load_count(&count_recvmsg);
  unsigned long getaddrinfo_count = load_count(&count_getaddrinfo);
  unsigned long getnameinfo_count = load_count(&count_getnameinfo);
  unsigned long gethostbyname_count = load_count(&count_gethostbyname);
  unsigned long gethostbyname2_count = load_count(&count_gethostbyname2);
  unsigned long total =
    socket_inet + socket_inet6 + connect_count + bind_count + listen_count
    + accept_count + send_count + sendto_count + sendmsg_count + recv_count
    + recvfrom_count + recvmsg_count + getaddrinfo_count + getnameinfo_count
    + gethostbyname_count + gethostbyname2_count;

  char receipt[4096];
  int length = snprintf(
    receipt,
    sizeof(receipt),
    "{"
      "\"schemaVersion\":\"usage-monitor-native-network-attempt-process-v0.1\","
      "\"instrumentation\":\"macos-dyld-libc-interposition-v0.1\","
      "\"totalAttempts\":%lu,"
      "\"byCategory\":{"
        "\"accept\":%lu,"
        "\"bind\":%lu,"
        "\"connect\":%lu,"
        "\"getaddrinfo\":%lu,"
        "\"gethostbyname\":%lu,"
        "\"gethostbyname2\":%lu,"
        "\"getnameinfo\":%lu,"
        "\"listen\":%lu,"
        "\"recv\":%lu,"
        "\"recvfrom\":%lu,"
        "\"recvmsg\":%lu,"
        "\"send\":%lu,"
        "\"sendmsg\":%lu,"
        "\"sendto\":%lu,"
        "\"socketInet\":%lu,"
        "\"socketInet6\":%lu"
      "},"
      "\"coverage\":{"
        "\"ipSocketLibc\":true,"
        "\"dnsLibc\":true,"
        "\"directSyscallInstruction\":false,"
        "\"quicFramework\":false,"
        "\"nonNodeChildProcesses\":false"
      "}"
    "}\n",
    total,
    accept_count,
    bind_count,
    connect_count,
    getaddrinfo_count,
    gethostbyname_count,
    gethostbyname2_count,
    getnameinfo_count,
    listen_count,
    recv_count,
    recvfrom_count,
    recvmsg_count,
    send_count,
    sendmsg_count,
    sendto_count,
    socket_inet,
    socket_inet6
  );
  if (length <= 0 || (size_t)length >= sizeof(receipt)) return;

  int descriptor = open(
    path,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
    S_IRUSR | S_IWUSR
  );
  if (descriptor < 0) return;
  bool written = write_complete(descriptor, receipt, (size_t)length);
  if (written) fsync(descriptor);
  close(descriptor);
}
