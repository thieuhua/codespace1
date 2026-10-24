"""Standard-library-only child-process memory limit and peak RSS measurement."""
import os

LIMIT = 1024 ** 3
_job_handle = None


def apply_memory_limit():
    global _job_handle
    if os.name == "posix":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (LIMIT, LIMIT))
        return "RLIMIT_AS=1GiB"
    if os.name == "nt":
        import ctypes as c
        from ctypes import wintypes as w
        class Basic(c.Structure):
            _fields_ = [("process_time", c.c_int64), ("job_time", c.c_int64),
                        ("flags", w.DWORD), ("min_ws", c.c_size_t), ("max_ws", c.c_size_t),
                        ("active", w.DWORD), ("affinity", c.c_size_t),
                        ("priority", w.DWORD), ("scheduling", w.DWORD)]
        class IO(c.Structure):
            _fields_ = [(name, c.c_uint64) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
        class Extended(c.Structure):
            _fields_ = [("basic", Basic), ("io", IO), ("process_limit", c.c_size_t),
                        ("job_limit", c.c_size_t), ("peak_process", c.c_size_t), ("peak_job", c.c_size_t)]
        kernel = c.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.restype = w.HANDLE
        kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
        kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        kernel.GetCurrentProcess.restype = w.HANDLE
        _job_handle = kernel.CreateJobObjectW(None, None)
        info = Extended()
        info.basic.flags = 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info.process_limit = LIMIT
        if (not _job_handle or not kernel.SetInformationJobObject(_job_handle, 9, c.byref(info), c.sizeof(info))
                or not kernel.AssignProcessToJobObject(_job_handle, kernel.GetCurrentProcess())):
            raise c.WinError(c.get_last_error())
        return "Windows Job process memory=1GiB"
    raise RuntimeError("No supported memory limit on this platform")


def peak_rss_bytes():
    if os.name == "posix":
        import resource
        import sys
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    import ctypes as c
    from ctypes import wintypes as w
    class Counters(c.Structure):
        _fields_ = [("cb", w.DWORD), ("faults", w.DWORD)] + [(name, c.c_size_t) for name in
                     ("peak_ws", "ws", "peak_paged", "paged", "peak_nonpaged", "nonpaged", "pagefile", "peak_pagefile")]
    kernel = c.WinDLL("kernel32")
    kernel.GetCurrentProcess.restype = w.HANDLE
    psapi = c.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, c.c_void_p, w.DWORD]
    counters = Counters()
    counters.cb = c.sizeof(counters)
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), c.byref(counters), counters.cb):
        raise c.WinError(c.get_last_error())
    return counters.peak_ws
